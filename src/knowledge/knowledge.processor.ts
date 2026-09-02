import { Logger, OnModuleInit } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { Job, UnrecoverableError } from 'bullmq';
import { KNOWLEDGE_JOBS_QUEUE_NAME } from '../queue/queue.constants';
import { DocumentChunksService } from '../documents/document-chunks.service';
import { KnowledgeNoteKind } from './knowledge-note.entity';
import { KnowledgeNotesService } from './knowledge-notes.service';
import { DocumentSummaryRequest, NoteGenerationService } from './note-generation.service';
import {
  BRAND_GUIDE_VERSION,
  DOCUMENT_SUMMARY_VERSION,
  InvalidNoteContentError,
  noteNeedsRegeneration,
} from './note-content';
import { looksLikeBrandGuide } from './brand-guide-detection';
import { buildStudyExcerpt } from './study-excerpt';
import { STUDY_DOCUMENT_JOB, StudyDocumentJobData } from './knowledge-job-data.interface';

export interface StudyResult {
  documentId: string;
  generated: KnowledgeNoteKind[];
  skipped: KnowledgeNoteKind[];
}

interface PlannedNote {
  kind: KnowledgeNoteKind;
  generatorVersion: number;
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

  /**
   * Todo documento ganha um resumo; brand guide ganha também a ficha dirigida.
   *
   * As duas notas são independentes: cada uma tem a própria versão de gerador e
   * a própria linha, então subir só o prompt do brand guide não obriga a reler o
   * acervo inteiro.
   */
  private planFor(data: StudyDocumentJobData): PlannedNote[] {
    const planned: PlannedNote[] = [
      {
        kind: KnowledgeNoteKind.DOCUMENT_SUMMARY,
        generatorVersion: DOCUMENT_SUMMARY_VERSION,
      },
    ];

    if (looksLikeBrandGuide(data)) {
      planned.push({ kind: KnowledgeNoteKind.BRAND_GUIDE, generatorVersion: BRAND_GUIDE_VERSION });
    }

    return planned;
  }

  private async studyDocument(data: StudyDocumentJobData): Promise<StudyResult> {
    const model = this.noteGeneration.model;
    const planned = this.planFor(data);

    const pending: PlannedNote[] = [];
    for (const note of planned) {
      const existing = await this.knowledgeNotesService.findDocumentNote(data.documentId, note.kind);
      const current = {
        model,
        generatorVersion: note.generatorVersion,
        sourceFingerprint: data.sha256,
      };
      if (noteNeedsRegeneration(existing, current)) pending.push(note);
    }

    const skipped = planned
      .filter((note) => !pending.includes(note))
      .map((note) => note.kind);

    if (pending.length === 0) {
      return { documentId: data.documentId, generated: [], skipped };
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

    const request: DocumentSummaryRequest = {
      filename: data.filename,
      scopePath: data.scopePath,
      excerpt,
    };

    const generated: KnowledgeNoteKind[] = [];
    for (const note of pending) {
      const content = await this.generate(note.kind, request, data.filename);

      await this.knowledgeNotesService.saveDocumentNote({
        documentId: data.documentId,
        clientId: data.clientId,
        scopePath: data.scopePath,
        kind: note.kind,
        model,
        generatorVersion: note.generatorVersion,
        sourceFingerprint: data.sha256,
        content,
      });

      generated.push(note.kind);
      this.logger.log(`Nota ${note.kind} de ${data.filename} gerada por ${model}`);
    }

    return { documentId: data.documentId, generated, skipped };
  }

  private async generate(
    kind: KnowledgeNoteKind,
    request: DocumentSummaryRequest,
    filename: string,
  ): Promise<Record<string, unknown>> {
    try {
      const content =
        kind === KnowledgeNoteKind.BRAND_GUIDE
          ? await this.noteGeneration.extractBrandGuide(request)
          : await this.noteGeneration.summarizeDocument(request);
      return { ...content };
    } catch (error) {
      // A geração é a `temperature: 0`, então a segunda tentativa devolveria a
      // mesma nota inválida: repetir só ocuparia a GPU.
      if (error instanceof InvalidNoteContentError) {
        this.logger.warn(`Nota ${kind} inválida para "${filename}": ${error.message}`);
        throw new UnrecoverableError(error.message);
      }
      throw error;
    }
  }
}
