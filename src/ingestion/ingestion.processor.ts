import { Logger, OnModuleInit } from '@nestjs/common';
import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { Job, Queue, UnrecoverableError } from 'bullmq';
import { INGESTION_JOBS_QUEUE_NAME, KNOWLEDGE_JOBS_QUEUE_NAME } from '../queue/queue.constants';
import {
  STUDY_DOCUMENT_JOB,
  StudyDocumentJobData,
} from '../knowledge/knowledge-job-data.interface';
import { DocumentsService } from '../documents/documents.service';
import { DocumentStatus } from '../documents/document.entity';
import { DocumentChunksService, NewClientChunk } from '../documents/document-chunks.service';
import { OllamaService } from '../ollama/ollama.service';
import { IngestionJobData } from './ingestion-job-data.interface';
import { DocumentContentPort } from './document-content.port';
import { TextExtractionService } from './extraction/text-extraction.service';
import {
  EmptyExtractionError,
  UnsupportedDocumentTypeError,
} from './extraction/extracted-text';
import { chunkPages } from './chunking';

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
    private readonly textExtraction: TextExtractionService,
    private readonly ollamaService: OllamaService,
    private readonly documentContent: DocumentContentPort,
    @InjectQueue(KNOWLEDGE_JOBS_QUEUE_NAME)
    private readonly knowledgeQueue: Queue<StudyDocumentJobData>,
  ) {
    super();
  }

  onModuleInit() {
    this.worker.concurrency = this.config.get<number>('queue.ingestionConcurrency', 1);
  }

  async process(job: Job<IngestionJobData>): Promise<IngestionResult> {
    const { documentId, clientId, scopePath, storagePath, filename } = job.data;
    await this.documentsService.updateStatus(documentId, DocumentStatus.PROCESSING);

    try {
      const file = await this.documentContent.fetch({ clientId, storagePath, filename });

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

      const rows: NewClientChunk[] = chunks.map((chunk, index) => ({
        chunkIndex: chunk.chunkIndex,
        pageNumber: chunk.pageNumber,
        content: chunk.content,
        embedding: embeddings[index],
      }));

      const written = await this.documentChunksService.replaceForDocument({
        documentId,
        clientId,
        scopePath,
        chunks: rows,
      });

      await this.documentsService.updateStatus(documentId, DocumentStatus.READY);
      this.logger.log(`${filename}: ${written} chunks (${extracted.source})`);

      await this.enqueueStudy(job.data);

      return { documentId, chunks: written, source: extracted.source };
    } catch (error) {
      await this.documentsService.updateStatus(documentId, DocumentStatus.FAILED);
      this.logger.warn(
        `Ingestão de "${storagePath}" falhou: ${error instanceof Error ? error.message : error}`,
      );

      // Tipo não suportado e arquivo sem texto não melhoram na segunda tentativa;
      // repetir só ocuparia a fila e a GPU.
      if (
        error instanceof UnsupportedDocumentTypeError ||
        error instanceof EmptyExtractionError
      ) {
        throw new UnrecoverableError(error.message);
      }
      throw error;
    }
  }

  private async enqueueStudy(data: IngestionJobData): Promise<void> {
    try {
      await this.knowledgeQueue.add(
        STUDY_DOCUMENT_JOB,
        {
          documentId: data.documentId,
          clientId: data.clientId,
          scopePath: data.scopePath,
          filename: data.filename,
          sha256: data.sha256,
        },
        {
          jobId: `${data.documentId}:${data.sha256}`,
          attempts: 3,
          backoff: { type: 'exponential', delay: 15000 },
          removeOnComplete: 1000,
          removeOnFail: 5000,
        },
      );
    } catch (error) {
      // O documento já está vetorizado e consultável; falhar a ingestão aqui a
      // desfaria e revetorizaria tudo por causa da nota, que é o acessório.
      this.logger.warn(
        `Não consegui enfileirar o estudo de "${data.filename}": ` +
          `${error instanceof Error ? error.message : error}`,
      );
    }
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
