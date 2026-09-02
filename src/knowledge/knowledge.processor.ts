import { Logger, OnModuleInit } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { Job, UnrecoverableError } from 'bullmq';
import { KNOWLEDGE_JOBS_QUEUE_NAME } from '../queue/queue.constants';
import { DocumentChunksService } from '../documents/document-chunks.service';
import { KnowledgeNoteKind } from './knowledge-note.entity';
import { KnowledgeNotesService } from './knowledge-notes.service';
import { NoteGenerationService } from './note-generation.service';
import { InvalidNoteContentError, DOCUMENT_SUMMARY_VERSION, noteNeedsRegeneration } from './note-content';
import { buildStudyExcerpt } from './study-excerpt';
import { STUDY_DOCUMENT_JOB, StudyDocumentJobData } from './knowledge-job-data.interface';

export interface StudyResult {
  documentId: string;
  kind: KnowledgeNoteKind;
  regenerated: boolean;
}

@Processor(KNOWLEDGE_JOBS_QUEUE_NAME)
export class KnowledgeProcessor extends WorkerHost implements OnModuleInit {
  private readonly logger = new Logger(KnowledgeProcessor.name);

  constructor(
    private readonly config: ConfigService,
    private readonly documentChunksService: DocumentChunksService,
    private readonly knowledgeNotesService: KnowledgeNotesService,
    private readonly noteGeneration: NoteGenerationService,
  ) {
    super();
  }

  onModuleInit() {
    this.worker.concurrency = this.config.get<number>('queue.knowledgeConcurrency', 1);
  }

  async process(job: Job<StudyDocumentJobData>): Promise<StudyResult> {
    if (job.name === STUDY_DOCUMENT_JOB) {
      return this.studyDocument(job.data);
    }
    throw new UnrecoverableError(`fila de conhecimento não conhece o job "${job.name}"`);
  }

  private async studyDocument(data: StudyDocumentJobData): Promise<StudyResult> {
    const kind = KnowledgeNoteKind.DOCUMENT_SUMMARY;
    const provenance = {
      model: this.noteGeneration.model,
      generatorVersion: DOCUMENT_SUMMARY_VERSION,
      sourceFingerprint: data.sha256,
    };

    const existing = await this.knowledgeNotesService.findDocumentNote(data.documentId, kind);
    if (!noteNeedsRegeneration(existing, provenance)) {
      return { documentId: data.documentId, kind, regenerated: false };
    }

    const chunks = await this.documentChunksService.contentForDocument(data.documentId);
    const excerpt = buildStudyExcerpt(
      chunks,
      this.config.get<number>('knowledge.excerptMaxChars', 12000),
    );

    if (!excerpt) {
      // Sem chunks não há o que estudar, e nenhuma repetição vai criá-los: quem
      // recria chunk é a ingestão, não esta fila.
      throw new UnrecoverableError(`documento ${data.documentId} não tem chunks para estudar`);
    }

    let content;
    try {
      content = await this.noteGeneration.summarizeDocument({
        filename: data.filename,
        scopePath: data.scopePath,
        excerpt,
      });
    } catch (error) {
      // A geração é a `temperature: 0`, então a segunda tentativa devolveria a
      // mesma nota inválida: repetir só ocuparia a GPU.
      if (error instanceof InvalidNoteContentError) {
        this.logger.warn(`Nota inválida para "${data.filename}": ${error.message}`);
        throw new UnrecoverableError(error.message);
      }
      throw error;
    }

    await this.knowledgeNotesService.saveDocumentNote({
      documentId: data.documentId,
      clientId: data.clientId,
      scopePath: data.scopePath,
      kind,
      ...provenance,
      content: { ...content },
    });

    this.logger.log(`Nota de ${data.filename} gerada por ${provenance.model}`);
    return { documentId: data.documentId, kind, regenerated: true };
  }
}
