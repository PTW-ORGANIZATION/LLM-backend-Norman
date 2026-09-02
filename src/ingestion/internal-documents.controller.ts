import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { InternalAuthGuard } from '../auth/internal-auth.guard';
import { DocumentsService } from '../documents/documents.service';
import { INGESTION_JOBS_QUEUE_NAME } from '../queue/queue.constants';
import { IngestionJobData } from './ingestion-job-data.interface';
import {
  ForgetPathDto,
  ForgetPrefixDto,
  RegisterDocumentDto,
  RenamePrefixDto,
} from './internal-documents.dto';

@UseGuards(InternalAuthGuard)
@Controller('internal/documents')
export class InternalDocumentsController {
  constructor(
    private readonly documentsService: DocumentsService,
    @InjectQueue(INGESTION_JOBS_QUEUE_NAME)
    private readonly ingestionQueue: Queue<IngestionJobData>,
  ) {}

  /**
   * Registra um arquivo do repositório do Norman e enfileira a ingestão dele.
   *
   * Idempotente pelo par cliente + caminho: reenviar o mesmo conteúdo já
   * ingerido devolve `queued: false` e não enfileira de novo, para que um
   * resync do repositório não revetorize o acervo inteiro.
   */
  @Post()
  async register(@Body() dto: RegisterDocumentDto) {
    const { document, changed } = await this.documentsService.registerClientDocument({
      clientId: dto.clientId,
      scopePath: dto.scopePath,
      storagePath: dto.storagePath,
      filename: dto.filename,
      sha256: dto.sha256,
      mimeType: dto.mimeType ?? null,
      sizeBytes: dto.sizeBytes ?? null,
    });

    if (!changed) {
      return { documentId: document.id, status: document.status, queued: false };
    }

    // O `jobId` é o par documento + conteúdo: uma segunda chamada com o mesmo
    // sha256 reaproveita o job que já está na fila em vez de duplicar trabalho.
    await this.ingestionQueue.add(
      'ingest-document',
      {
        documentId: document.id,
        clientId: dto.clientId,
        scopePath: dto.scopePath,
        storagePath: dto.storagePath,
        filename: dto.filename,
        sha256: dto.sha256,
      },
      {
        jobId: `${document.id}:${dto.sha256}`,
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: 1000,
        removeOnFail: 5000,
      },
    );

    return { documentId: document.id, status: document.status, queued: true };
  }

  /** Esquece um arquivo que saiu do repositório do Norman. */
  @Post('forget-path')
  async forgetPath(@Body() dto: ForgetPathDto) {
    return { removed: await this.documentsService.forgetPath(dto) };
  }

  /** Esquece uma pasta inteira do repositório do Norman, e tudo abaixo dela. */
  @Post('forget-prefix')
  async forgetPrefix(@Body() dto: ForgetPrefixDto) {
    return { removed: await this.documentsService.forgetPrefix(dto) };
  }

  /**
   * Move o acervo de uma pasta renomeada para o caminho novo. Não revetoriza: o
   * embedding não depende de onde a pasta está.
   */
  @Post('rename-prefix')
  async renamePrefix(@Body() dto: RenamePrefixDto) {
    return { updated: await this.documentsService.renamePrefix(dto) };
  }

  @Get(':id')
  async status(@Param('id') id: string) {
    const document = await this.documentsService.findById(id);
    if (!document) return { documentId: id, status: null };
    return {
      documentId: document.id,
      status: document.status,
      clientId: document.clientId,
      scopePath: document.scopePath,
      sha256: document.sha256,
      updatedAt: document.updatedAt,
    };
  }
}
