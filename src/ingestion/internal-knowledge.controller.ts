import {
  BadRequestException,
  Body,
  Controller,
  Logger,
  NotFoundException,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { FileInterceptor } from '@nestjs/platform-express';
import { Queue } from 'bullmq';
import { InternalAuthGuard } from '../auth/internal-auth.guard';
import { InternalCapabilityGuard } from '../auth/internal-capability.guard';
import {
  RequiresCapability,
  RequiresCapabilityByScope,
} from '../auth/internal-capabilities';
import { DocumentChunksService } from '../documents/document-chunks.service';
import { DocumentsService } from '../documents/documents.service';
import { OllamaService } from '../ollama/ollama.service';
import { KnowledgeNoteKind } from '../knowledge/knowledge-note.entity';
import { KnowledgeNotesService } from '../knowledge/knowledge-notes.service';
import { KnowledgeJobData } from '../knowledge/knowledge-job-data.interface';
import { enqueueClientConsolidation } from '../knowledge/knowledge-queue';
import { applyRetrievalBudget } from '../knowledge/retrieval-budget';
import { INGESTION_JOBS_QUEUE_NAME, KNOWLEDGE_JOBS_QUEUE_NAME } from '../queue/queue.constants';
import { clientDossierJobId, ingestDocumentJobId } from '../queue/job-id';
import { IngestionJobData } from './ingestion-job-data.interface';
import {
  ClientDossierDto,
  ClientOverviewDto,
  KnowledgeSearchDto,
  ReprocessDocumentDto,
  ScopeStatusDto,
  SystemOverviewDto,
} from './internal-documents.dto';
import {
  CLIENT_SCOPE,
  IngestionScope,
  SYSTEM_SCOPE,
} from '../documents/knowledge-scope';
import type { SearchScope } from '../documents/document-chunks.service';
import { TextExtractionService } from './extraction/text-extraction.service';
import { inspectForAudioPayload } from './audio-payload.guard';

// Rotas de serviço, autenticadas pelo token interno do Norman. O token diz que a
// chamada vem do Norman, NÃO que o usuário por trás dela é administrador: quem
// conhece perfil e permissão é o Norman, e é lá que a tela de conhecimento do
// cliente tem de ser fechada. Nada aqui devolve embedding, prompt de sistema ou
// segredo, para que um vazamento de tela não vire vazamento de infraestrutura.
@UseGuards(InternalAuthGuard, InternalCapabilityGuard)
@Controller('internal/knowledge')
export class InternalKnowledgeController {
  private readonly logger = new Logger(InternalKnowledgeController.name);

  constructor(
    private readonly config: ConfigService,
    private readonly documentChunksService: DocumentChunksService,
    private readonly documentsService: DocumentsService,
    private readonly ollamaService: OllamaService,
    private readonly knowledgeNotesService: KnowledgeNotesService,
    private readonly textExtractionService: TextExtractionService,
    @InjectQueue(INGESTION_JOBS_QUEUE_NAME)
    private readonly ingestionQueue: Queue<IngestionJobData>,
    @InjectQueue(KNOWLEDGE_JOBS_QUEUE_NAME)
    private readonly knowledgeQueue: Queue<KnowledgeJobData>,
  ) {}

  @RequiresCapability('documents.extract')
  @Post('extract-document')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 104857600, files: 1 } }))
  async extractDocument(
    @UploadedFile() file?: { buffer: Buffer; originalname: string; mimetype: string },
  ) {
    if (!file) throw new BadRequestException('arquivo é obrigatório');
    const audio = inspectForAudioPayload({
      mimeType: file.mimetype,
      filename: file.originalname,
      content: file.buffer,
    });
    if (audio.rejected) throw new BadRequestException(audio.reason);

    const extracted = await this.textExtractionService.extract({
      content: file.buffer,
      filename: file.originalname,
      mimeType: file.mimetype,
    });
    return {
      text: extracted.pages.map((page) => page.text).join('\n\n'),
      source: extracted.source,
    };
  }

  /**
   * Os trechos do acervo de um cliente relevantes para uma pergunta.
   *
   * Recupera só dos níveis ancestrais de `scopePath` e só do cliente informado —
   * é `searchSimilar` no escopo de cliente que garante isso, e nada aqui afrouxa.
   * Devolve lista vazia quando não há o que recuperar; quem chama trata vazio
   * como "não há conhecimento", nunca como erro.
   */
  @RequiresCapabilityByScope('knowledge.client.read', 'knowledge.system.read')
  @Post('search')
  async search(@Body() dto: KnowledgeSearchDto) {
    const level: IngestionScope = dto.scope === SYSTEM_SCOPE ? SYSTEM_SCOPE : CLIENT_SCOPE;
    // Cada nível é uma consulta com o próprio filtro, e o filtro é o
    // discriminador persistido. Nada aqui devolve as duas camadas juntas: a
    // mesclagem com precedência do cliente é decisão da geração, e fazê-la
    // também aqui daria dois lugares para ela divergir.
    const scope: SearchScope =
      level === SYSTEM_SCOPE
        ? { kind: 'system', excludeScopePaths: dto.excludeScopePaths }
        : {
            kind: 'client',
            clientId: String(dto.clientId || ''),
            scopePath: dto.scopePath,
            includeDescendants: dto.includeDescendants,
            excludeScopePaths: dto.excludeScopePaths,
          };

    const embedding = await this.ollamaService.embed(dto.question);
    const chunks = await this.documentChunksService.searchSimilar({
      scope,
      embedding,
      embeddingModel: this.config.get<string>('ollama.embeddingModel', 'nomic-embed-text'),
    });

    const { snippets, evidence } = applyRetrievalBudget(chunks, {
      minSimilarity: this.config.get<number>('knowledge.retrievalMinSimilarity', 0.25),
      maxChars: this.config.get<number>('knowledge.retrievalMaxChars', 8000),
      maxSnippets: this.config.get<number>('knowledge.retrievalMaxSnippets', 5),
    });

    return { scope: level, snippets, evidence };
  }

  /**
   * O estado de ingestão de cada arquivo de uma pasta, para a tela do
   * repositório do Norman mostrar ao lado do arquivo.
   *
   * Só a pasta pedida, sem descer: é o que a tela lista. Pasta sem nada ingerido
   * devolve lista vazia, que a tela trata como "nada a mostrar".
   */
  @RequiresCapabilityByScope('knowledge.client.read', 'knowledge.system.read')
  @Post('scope-status')
  async scopeStatus(@Body() dto: ScopeStatusDto) {
    const scope: IngestionScope = dto.scope === SYSTEM_SCOPE ? SYSTEM_SCOPE : CLIENT_SCOPE;
    return {
      scope,
      documents: await this.knowledgeNotesService.listScopeStatus({
        scope,
        clientId: scope === SYSTEM_SCOPE ? null : dto.clientId,
        scopePath: dto.scopePath,
      }),
    };
  }

  /**
   * O dossiê consolidado de um cliente, ou nulo.
   *
   * `state` separa as três ausências que o Norman precisa distinguir: `absent`
   * é quem ainda não tem acervo estudado, `stale` é dossiê tirado de circulação
   * porque um documento saiu do acervo e o recálculo ainda não terminou, e
   * `current` é dossiê válido. Só `current` traz conteúdo — dossiê marcado
   * descreve arquivo que já não existe e não pode voltar a uma resposta.
   */
  @RequiresCapability('knowledge.client.read')
  @Post('dossier')
  async dossier(@Body() dto: ClientDossierDto) {
    const note = await this.knowledgeNotesService.findClientNote(
      dto.clientId,
      KnowledgeNoteKind.CLIENT_DOSSIER,
    );
    const stale = Boolean(note?.staleSince);

    return {
      dossier: note && !stale ? note.content : null,
      updatedAt: note?.updatedAt ?? null,
      state: !note ? 'absent' : stale ? 'stale' : 'current',
      staleSince: note?.staleSince ?? null,
      staleReason: note?.staleReason ?? null,
    };
  }

  /**
   * Tudo o que a tela de conhecimento de um cliente mostra, numa chamada.
   *
   * Uma chamada só porque a tela precisa das três coisas juntas para ser
   * coerente: se documento, nota e dossiê viessem de requisições separadas, um
   * reprocessamento em andamento apareceria como documento novo ao lado de um
   * dossiê que ainda não o conhece.
   *
   * Cliente sem acervo devolve listas vazias e `dossier: null` — é o caso normal
   * de quem nunca enviou arquivo, e a tela trata como "nada estudado ainda",
   * nunca como erro.
   */
  @RequiresCapability('knowledge.client.read')
  @Post('client-overview')
  async clientOverview(@Body() dto: ClientOverviewDto) {
    const [documents, noteDetails, dossier, dossierJob] = await Promise.all([
      this.knowledgeNotesService.listClientDocuments(dto.clientId, dto.limit),
      this.knowledgeNotesService.listDocumentNoteDetails(dto.clientId),
      this.knowledgeNotesService.findClientNote(dto.clientId, KnowledgeNoteKind.CLIENT_DOSSIER),
      this.hasDossierJob(dto.clientId),
    ]);

    const notesByDocument = new Map<string, typeof noteDetails>();
    for (const note of noteDetails) {
      const existing = notesByDocument.get(note.documentId) ?? [];
      existing.push(note);
      notesByDocument.set(note.documentId, existing);
    }

    const dossierStale = Boolean(dossier?.staleSince);

    return {
      clientId: dto.clientId,
      dossierRegenerating: dossierJob,
      dossierState: !dossier ? 'absent' : dossierStale ? 'stale' : 'current',
      dossierStaleSince: dossier?.staleSince ?? null,
      dossierStaleReason: dossier?.staleReason ?? null,
      dossier: dossier && !dossierStale
        ? {
            content: dossier.content,
            model: dossier.model,
            generatorVersion: dossier.generatorVersion,
            updatedAt: dossier.updatedAt,
          }
        : null,
      documents: documents.map((document) => ({
        ...document,
        notes: (notesByDocument.get(document.documentId) ?? []).map((note) => ({
          kind: note.kind,
          content: note.content,
          model: note.model,
          generatorVersion: note.generatorVersion,
          updatedAt: note.updatedAt,
        })),
      })),
    };
  }

  /**
   * O acervo geral do sistema, para a aba **Conhecimentos gerais do sistema**.
   *
   * Sem dossiê e sem cliente: o dossiê é o retrato consolidado de um cliente, e
   * o acervo geral contribui com trechos e notas de documento. A tela mostra
   * exatamente isso, e não um resumo do "sistema" que nenhuma geração consulta.
   */
  @RequiresCapability('knowledge.system.read')
  @Post('system-overview')
  async systemOverview(@Body() dto: SystemOverviewDto) {
    const [documents, noteDetails] = await Promise.all([
      this.knowledgeNotesService.listSystemDocuments(dto.limit),
      this.knowledgeNotesService.listSystemNoteDetails(),
    ]);

    const notesByDocument = new Map<string, typeof noteDetails>();
    for (const note of noteDetails) {
      const existing = notesByDocument.get(note.documentId) ?? [];
      existing.push(note);
      notesByDocument.set(note.documentId, existing);
    }

    return {
      scope: SYSTEM_SCOPE,
      documents: documents.map((document) => ({
        ...document,
        notes: (notesByDocument.get(document.documentId) ?? []).map((note) => ({
          kind: note.kind,
          content: note.content,
          model: note.model,
          generatorVersion: note.generatorVersion,
          updatedAt: note.updatedAt,
        })),
      })),
    };
  }

  /**
   * Devolve um documento à fila de ingestão, do começo.
   *
   * O job antigo é removido antes de enfileirar o novo. O `jobId` é
   * determinístico pelo par documento + conteúdo, e a fila guarda job concluído
   * (`removeOnComplete: 1000`): sem a remoção, um segundo `add` com o mesmo id
   * seria descartado em silêncio e o botão de tentar de novo não faria nada.
   */
  @RequiresCapabilityByScope('knowledge.client.write', 'knowledge.system.write')
  @Post('reprocess-document')
  async reprocessDocument(@Body() dto: ReprocessDocumentDto) {
    const scope: IngestionScope = dto.scope === SYSTEM_SCOPE ? SYSTEM_SCOPE : CLIENT_SCOPE;
    const clientId = scope === SYSTEM_SCOPE ? null : String(dto.clientId || '');
    const document = await this.documentsService.findByScopePath(scope, clientId, dto.storagePath);
    if (!document) {
      throw new NotFoundException(
        scope === SYSTEM_SCOPE
          ? 'documento não está no acervo geral do sistema'
          : 'documento não está no acervo deste cliente',
      );
    }
    if (!document.sha256 || !document.scopePath) {
      throw new NotFoundException('documento sem conteúdo registrado para reprocessar');
    }

    const jobId = ingestDocumentJobId(document.id, document.sha256);
    await this.discardJob(this.ingestionQueue, jobId);
    await this.documentsService.markPending(document.id);

    await this.ingestionQueue.add(
      'ingest-document',
      {
        documentId: document.id,
        knowledgeScope: scope,
        clientId,
        scopePath: document.scopePath,
        storagePath: document.storagePath,
        filename: document.filename,
        sha256: document.sha256,
      },
      {
        jobId,
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: 1000,
        removeOnFail: 5000,
      },
    );

    return { documentId: document.id, status: 'pending', queued: true };
  }

  /**
   * Refaz o dossiê do cliente agora, sem esperar a janela de agrupamento.
   *
   * O job de dossiê tem id fixo por cliente e nasce com atraso para juntar uma
   * rajada de envios num só. Aqui o pedido é explícito de uma pessoa olhando a
   * tela, então o job pendente é descartado e o novo entra sem atraso.
   */
  @RequiresCapability('knowledge.client.write')
  @Post('regenerate-dossier')
  async regenerateDossier(@Body() dto: ClientDossierDto) {
    await this.discardJob(this.knowledgeQueue, clientDossierJobId(dto.clientId));
    await enqueueClientConsolidation(this.knowledgeQueue, dto.clientId, 0);
    return { clientId: dto.clientId, queued: true };
  }

  /**
   * Descarta um job pelo id para que o mesmo id possa ser enfileirado de novo.
   *
   * Falha de remoção é ignorada: o motivo normal é o job estar ativo neste
   * instante, e nesse caso o trabalho que o pedido queria já está acontecendo.
   */
  private async discardJob<T>(queue: Queue<T>, jobId: string): Promise<void> {
    try {
      await queue.remove(jobId);
    } catch (error) {
      this.logger.warn(
        `Não consegui descartar o job ${jobId}: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  private async hasDossierJob(clientId: string): Promise<boolean> {
    try {
      return Boolean(await this.knowledgeQueue.getJob(clientDossierJobId(clientId)));
    } catch (error) {
      this.logger.warn(
        `Não consegui consultar o job do dossiê de ${clientId}: ${error instanceof Error ? error.message : error}`,
      );
      return false;
    }
  }
}
