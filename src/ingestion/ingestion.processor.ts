import { createHash } from 'node:crypto';
import { Logger, OnModuleInit } from '@nestjs/common';
import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { Job, Queue, UnrecoverableError } from 'bullmq';
import { INGESTION_JOBS_QUEUE_NAME, KNOWLEDGE_JOBS_QUEUE_NAME } from '../queue/queue.constants';
import { KnowledgeJobData } from '../knowledge/knowledge-job-data.interface';
import { enqueueDocumentStudy } from '../knowledge/knowledge-queue';
import { DocumentsService } from '../documents/documents.service';
import { RevocationsService } from '../documents/revocations.service';
import { DocumentChunksService, NewClientChunk } from '../documents/document-chunks.service';
import { EMBEDDING_DIMENSIONS, OllamaService } from '../ollama/ollama.service';
import { IngestionJobData } from './ingestion-job-data.interface';
import { DocumentContentPort } from './document-content.port';
import { TextExtractionService } from './extraction/text-extraction.service';
import {
  DocumentTooLargeError,
  EmptyExtractionError,
  MalformedDocumentError,
  ProtectedDocumentError,
  UnsupportedDocumentTypeError,
} from './extraction/extracted-text';
import { chunkPages } from './chunking';
import { CLIENT_SCOPE, IngestionScope, SYSTEM_SCOPE } from '../documents/knowledge-scope';

export class ContentMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContentMismatchError';
  }
}

export interface IngestionResult {
  documentId: string;
  chunks: number;
  source: string;
}

@Processor(INGESTION_JOBS_QUEUE_NAME)
export class IngestionProcessor extends WorkerHost implements OnModuleInit {
  private readonly logger = new Logger(IngestionProcessor.name);

  constructor(
    private readonly config: ConfigService,
    private readonly documentsService: DocumentsService,
    private readonly documentChunksService: DocumentChunksService,
    private readonly revocationsService: RevocationsService,
    private readonly textExtraction: TextExtractionService,
    private readonly ollamaService: OllamaService,
    private readonly documentContent: DocumentContentPort,
    @InjectQueue(KNOWLEDGE_JOBS_QUEUE_NAME)
    private readonly knowledgeQueue: Queue<KnowledgeJobData>,
  ) {
    super();
  }

  onModuleInit() {
    this.worker.concurrency = this.config.get<number>('queue.ingestionConcurrency', 1);
  }

  async process(job: Job<IngestionJobData>): Promise<IngestionResult> {
    const { documentId, scopePath, storagePath, filename, sha256 } = job.data;
    // Job antigo, enfileirado antes de o nível existir no payload, é de cliente:
    // o acervo geral nasce nesta versão e nenhum job anterior a ele pertence.
    const scope: IngestionScope = job.data.knowledgeScope === SYSTEM_SCOPE ? SYSTEM_SCOPE : CLIENT_SCOPE;
    const clientId = scope === CLIENT_SCOPE ? String(job.data.clientId || '') : null;
    await this.documentsService.markProcessing(documentId);

    try {
      const file = await this.documentContent.fetch({
        scope,
        clientId,
        storagePath,
        filename,
        expectedSha256: sha256 || null,
      });

      const receivedSha256 = createHash('sha256').update(file.content).digest('hex');
      if (sha256 && receivedSha256 !== sha256) {
        throw new ContentMismatchError(
          `"${storagePath}" devolveu bytes de outra versão: esperado ${sha256}, recebido ${receivedSha256}`,
        );
      }

      const extracted = await this.textExtraction.extract({
        content: file.content,
        filename: file.filename,
        mimeType: file.mimeType,
      });

      const chunks = chunkPages(extracted.pages, {
        chunkSize: this.config.get<number>('ingestion.chunkSize', 1200),
        overlap: this.config.get<number>('ingestion.chunkOverlap', 150),
      });

      if (chunks.length === 0) {
        throw new EmptyExtractionError(`${filename} não produziu nenhum chunk`);
      }

      const embeddings = await this.embedAll(chunks.map((chunk) => chunk.content));

      // A revogação pode ter chegado enquanto o arquivo era lido e vetorizado.
      // Publicar agora devolveria ao acervo o que alguém acabou de tirar dele.
      if (await this.revocationsService.isRevoked(clientId, storagePath, scope)) {
        this.logger.warn(`Ingestão de "${storagePath}" descartada: o caminho foi revogado.`);
        await this.documentsService.forgetPath({ scope, clientId, storagePath });
        return { documentId, chunks: 0, source: extracted.source };
      }

      const rows: NewClientChunk[] = chunks.map((chunk, index) => ({
        chunkIndex: chunk.chunkIndex,
        pageNumber: chunk.pageNumber,
        content: chunk.content,
        embedding: embeddings[index],
      }));

      const written = await this.documentChunksService.replaceForDocument({
        documentId,
        scope,
        clientId,
        scopePath,
        embeddingModel: this.embeddingModel(),
        embeddingDimensions: EMBEDDING_DIMENSIONS,
        chunks: rows,
      });

      await this.documentsService.markReady(documentId, extracted.source);
      this.logger.log(`${filename}: ${written} chunks (${extracted.source})`);

      await this.enqueueStudy({ ...job.data, knowledgeScope: scope, clientId });

      return { documentId, chunks: written, source: extracted.source };
    } catch (error) {
      await this.documentsService.markFailed(
        documentId,
        error instanceof Error ? error.message : String(error),
      );
      this.logger.warn(
        `Ingestão de "${storagePath}" falhou: ${error instanceof Error ? error.message : error}`,
      );

      // Nada aqui melhora na segunda tentativa: o tipo continua o mesmo, o
      // arquivo continua sem texto, corrompido, cifrado ou grande demais.
      // Repetir só ocuparia a fila e a GPU.
      if (
        error instanceof UnsupportedDocumentTypeError ||
        error instanceof EmptyExtractionError ||
        error instanceof MalformedDocumentError ||
        error instanceof ProtectedDocumentError ||
        error instanceof DocumentTooLargeError
      ) {
        throw new UnrecoverableError(error.message);
      }
      throw error;
    }
  }

  private async enqueueStudy(data: IngestionJobData): Promise<void> {
    try {
      await enqueueDocumentStudy(this.knowledgeQueue, {
        documentId: data.documentId,
        knowledgeScope: data.knowledgeScope,
        clientId: data.clientId,
        scopePath: data.scopePath,
        filename: data.filename,
        sha256: data.sha256,
      });
    } catch (error) {
      // O documento já está vetorizado e consultável; falhar a ingestão aqui a
      // desfaria e revetorizaria tudo por causa da nota, que é o acessório.
      this.logger.warn(
        `Não consegui enfileirar o estudo de "${data.filename}": ` +
          `${error instanceof Error ? error.message : error}`,
      );
    }
  }

  private embeddingModel(): string {
    return this.config.get<string>('ollama.embeddingModel', 'nomic-embed-text');
  }

  private async embedAll(texts: string[]): Promise<number[][]> {
    const batchSize = Math.max(1, this.config.get<number>('ingestion.embedBatchSize', 16));
    const embeddings: number[][] = [];

    for (let offset = 0; offset < texts.length; offset += batchSize) {
      const batch = texts.slice(offset, offset + batchSize);
      embeddings.push(...(await this.ollamaService.embedBatch(batch)));
    }

    return embeddings;
  }
}
