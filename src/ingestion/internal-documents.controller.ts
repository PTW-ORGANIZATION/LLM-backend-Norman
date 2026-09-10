import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Logger,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ingestDocumentJobId } from '../queue/job-id';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { ConfigService } from '@nestjs/config';
import { InternalAuthGuard } from '../auth/internal-auth.guard';
import { InternalCapabilityGuard } from '../auth/internal-capability.guard';
import {
  RequiresAnyCapability,
  RequiresCapabilityByScope,
} from '../auth/internal-capabilities';
import type { ConsumerApplication } from '../auth/consumer-registry';
import { DocumentsService } from '../documents/documents.service';
import { RevocationsService } from '../documents/revocations.service';
import { KnowledgeNotesService } from '../knowledge/knowledge-notes.service';
import { INGESTION_JOBS_QUEUE_NAME, KNOWLEDGE_JOBS_QUEUE_NAME } from '../queue/queue.constants';
import { KnowledgeJobData } from '../knowledge/knowledge-job-data.interface';
import { enqueueClientConsolidation } from '../knowledge/knowledge-queue';
import { IngestionJobData } from './ingestion-job-data.interface';
import { inspectForAudioPayload } from './audio-payload.guard';
import {
  ForgetPathDto,
  ForgetPrefixDto,
  RegisterDocumentDto,
  RenamePrefixDto,
  RevocationStateDto,
} from './internal-documents.dto';
import { CLIENT_SCOPE, IngestionScope, SYSTEM_SCOPE } from '../documents/knowledge-scope';

/**
 * O nível declarado no pedido, com `client` como ausência.
 *
 * A normalização mora num lugar só para que nenhuma rota decida sozinha o que
 * fazer com o campo ausente: omissão é sempre o nível estreito.
 */
function requestedScope(dto: { scope?: IngestionScope }): IngestionScope {
  return dto.scope === SYSTEM_SCOPE ? SYSTEM_SCOPE : CLIENT_SCOPE;
}

/** O dono do pedido: o cliente no nível `client`, e ninguém no nível `system`. */
function requestedOwner(dto: { scope?: IngestionScope; clientId?: string }): string | null {
  return requestedScope(dto) === SYSTEM_SCOPE ? null : String(dto.clientId || '');
}

@UseGuards(InternalAuthGuard, InternalCapabilityGuard)
@Controller('internal/documents')
export class InternalDocumentsController {
  private readonly logger = new Logger(InternalDocumentsController.name);

  constructor(
    private readonly config: ConfigService,
    private readonly documentsService: DocumentsService,
    private readonly revocationsService: RevocationsService,
    private readonly knowledgeNotesService: KnowledgeNotesService,
    @InjectQueue(INGESTION_JOBS_QUEUE_NAME)
    private readonly ingestionQueue: Queue<IngestionJobData>,
    @InjectQueue(KNOWLEDGE_JOBS_QUEUE_NAME)
    private readonly knowledgeQueue: Queue<KnowledgeJobData>,
  ) {}

  /**
   * Registra um arquivo do repositório do Norman e enfileira a ingestão dele.
   *
   * Idempotente pelo par cliente + caminho: reenviar o mesmo conteúdo já
   * ingerido devolve `queued: false` e não enfileira de novo, para que um
   * resync do repositório não revetorize o acervo inteiro.
   */
  @RequiresCapabilityByScope('knowledge.client.write', 'knowledge.system.write')
  @Post()
  async register(@Body() dto: RegisterDocumentDto) {
    const audio = inspectForAudioPayload({ mimeType: dto.mimeType, filename: dto.filename });
    if (audio.rejected) throw new BadRequestException(audio.reason);

    const scope = requestedScope(dto);
    const clientId = requestedOwner(dto);

    if (dto.origin === 'administrative') {
      await this.revocationsService.lift(clientId, dto.storagePath, scope);
    }

    if (await this.revocationsService.isRevoked(clientId, dto.storagePath, scope)) {
      return { documentId: null, status: null, queued: false, revoked: true };
    }

    const { document, changed } = await this.documentsService.registerClientDocument({
      scope,
      clientId,
      scopePath: dto.scopePath,
      storagePath: dto.storagePath,
      filename: dto.filename,
      sha256: dto.sha256,
      mimeType: dto.mimeType ?? null,
      sizeBytes: dto.sizeBytes ?? null,
    });

    if (!changed) {
      return { documentId: document.id, status: document.status, queued: false, revoked: false };
    }

    // O `jobId` é o par documento + conteúdo: uma segunda chamada com o mesmo
    // sha256 reaproveita o job que já está na fila em vez de duplicar trabalho.
    await this.ingestionQueue.add(
      'ingest-document',
      {
        documentId: document.id,
        knowledgeScope: scope,
        clientId,
        scopePath: dto.scopePath,
        storagePath: dto.storagePath,
        filename: dto.filename,
        sha256: dto.sha256,
      },
      {
        jobId: ingestDocumentJobId(document.id, dto.sha256),
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: 1000,
        removeOnFail: 5000,
      },
    );

    return { documentId: document.id, status: document.status, queued: true, revoked: false };
  }

  @RequiresCapabilityByScope('knowledge.client.read', 'knowledge.system.read')
  @Post('revocation-state')
  async revocationState(@Body() dto: RevocationStateDto) {
    const scope = requestedScope(dto);
    const clientId = requestedOwner(dto);
    const revoked: string[] = [];
    for (const path of dto.paths) {
      if (await this.revocationsService.isRevoked(clientId, path, scope)) revoked.push(path);
    }
    return { scope, revoked };
  }

  /**
   * Tira um arquivo do acervo, com lápide.
   *
   * Devolve `revocationState` porque quem chama precisa distinguir revogação
   * confirmada de tentativa que não chegou: sem isso o Norman marcaria a fonte
   * como revogada com base na ausência de exceção, que é o que deixava os
   * trechos antigos pesquisáveis depois de uma falha de rede.
   */
  @RequiresCapabilityByScope('knowledge.client.write', 'knowledge.system.write')
  @Post('forget-path')
  async forgetPath(@Body() dto: ForgetPathDto) {
    const scope = requestedScope(dto);
    const clientId = requestedOwner(dto);
    const { removed, tombstones } = await this.revocationsService.revokePath({
      scope,
      clientId,
      storagePath: dto.storagePath,
      reason: dto.reason ?? null,
    });
    return {
      scope,
      removed,
      revocationState: 'confirmed' as const,
      tombstones,
      ...(await this.invalidateDerivatives(scope, clientId, removed, dto.storagePath)),
    };
  }

  /** Tira do acervo uma pasta inteira do repositório do Norman, e tudo abaixo dela. */
  @RequiresCapabilityByScope('knowledge.client.write', 'knowledge.system.write')
  @Post('forget-prefix')
  async forgetPrefix(@Body() dto: ForgetPrefixDto) {
    const scope = requestedScope(dto);
    const clientId = requestedOwner(dto);
    const { removed, tombstones } = await this.revocationsService.revokePrefix({
      scope,
      clientId,
      scopePath: dto.scopePath,
      reason: dto.reason ?? null,
    });
    return {
      scope,
      removed,
      revocationState: 'confirmed' as const,
      tombstones,
      ...(await this.invalidateDerivatives(scope, clientId, removed, dto.scopePath)),
    };
  }

  /**
   * Tira de circulação o que derivava do arquivo removido, antes de responder.
   *
   * A marca de desatualização é gravada no banco na mesma chamada, e é ela que
   * cumpre a promessa do PDF: remover impede o uso em novas respostas mesmo que
   * a fila esteja fora do ar e a reconsolidação demore. `reconsolidationQueued`
   * diz se o recálculo já está agendado — resposta com `false` significa dossiê
   * fora de circulação esperando recálculo, não remoção incompleta.
   */
  private async invalidateDerivatives(
    scope: IngestionScope,
    clientId: string | null,
    removed: number,
    origin: string,
  ): Promise<{ invalidated: number; reconsolidationQueued: boolean }> {
    if (removed <= 0) return { invalidated: 0, reconsolidationQueued: false };

    // O acervo geral não tem dossiê consolidado a invalidar: a remoção física
    // do documento já apaga os chunks dele por cascata, e é isso que faz a
    // fonte geral parar de aparecer para **todos** os clientes na mesma
    // chamada. Não há nota de cliente derivada dela para marcar.
    if (scope === SYSTEM_SCOPE || !clientId) {
      return { invalidated: 0, reconsolidationQueued: false };
    }

    const invalidated = await this.knowledgeNotesService.markClientNotesStale(
      clientId,
      `documento removido do acervo: ${origin}`,
    );

    return { invalidated, reconsolidationQueued: await this.scheduleConsolidation(clientId) };
  }

  private async scheduleConsolidation(clientId: string): Promise<boolean> {
    try {
      await enqueueClientConsolidation(
        this.knowledgeQueue,
        clientId,
        this.config.get<number>('knowledge.dossierDelayMs', 60000),
      );
      return true;
    } catch (error) {
      this.logger.warn(
        `Não consegui enfileirar o dossiê de ${clientId}: ` +
          `${error instanceof Error ? error.message : error}`,
      );
      return false;
    }
  }

  /**
   * Move o acervo de uma pasta renomeada para o caminho novo. Não revetoriza: o
   * embedding não depende de onde a pasta está.
   */
  @RequiresCapabilityByScope('knowledge.client.write', 'knowledge.system.write')
  @Post('rename-prefix')
  async renamePrefix(@Body() dto: RenamePrefixDto) {
    return {
      updated: await this.documentsService.renamePrefix({
        scope: requestedScope(dto),
        clientId: requestedOwner(dto),
        fromPath: dto.fromPath,
        toPath: dto.toPath,
      }),
    };
  }

  @RequiresAnyCapability('knowledge.client.read', 'knowledge.system.read')
  @Get(':id')
  async status(@Param('id') id: string, @Req() request?: { consumer?: ConsumerApplication }) {
    const document = await this.documentsService.findById(id);
    if (!document) return { documentId: id, status: null };
    this.assertReadsLevel(request?.consumer, document.knowledgeScope);
    return {
      documentId: document.id,
      status: document.status,
      scope: document.knowledgeScope,
      clientId: document.clientId,
      scopePath: document.scopePath,
      sha256: document.sha256,
      updatedAt: document.updatedAt,
    };
  }

  private assertReadsLevel(consumer: ConsumerApplication | undefined, level: string): void {
    const required = level === SYSTEM_SCOPE ? 'knowledge.system.read' : 'knowledge.client.read';
    if ((consumer?.capabilities ?? []).includes(required)) return;
    throw new ForbiddenException(
      `a aplicação "${consumer?.name ?? 'desconhecida'}" não recebeu ${required}`,
    );
  }
}
