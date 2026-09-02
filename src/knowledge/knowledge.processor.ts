import { Logger, OnModuleInit } from '@nestjs/common';
import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { Job, Queue, UnrecoverableError } from 'bullmq';
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
import {
  assembleClientDossier,
  brandGuideOf,
  buildClientCorpus,
  CLIENT_DOSSIER_VERSION,
  dossierDocuments,
  fingerprintClientNotes,
} from './client-dossier';
import { looksLikeBrandGuide } from './brand-guide-detection';
import { buildStudyExcerpt } from './study-excerpt';
import {
  CONSOLIDATE_CLIENT_JOB,
  ConsolidateClientJobData,
  KnowledgeJobData,
  STUDY_DOCUMENT_JOB,
  StudyDocumentJobData,
} from './knowledge-job-data.interface';
import { enqueueClientConsolidation } from './knowledge-queue';

export interface StudyResult {
  documentId: string;
  generated: KnowledgeNoteKind[];
  skipped: KnowledgeNoteKind[];
}

export interface ConsolidateResult {
  clientId: string;
  documents: number;
  regenerated: boolean;
}

export type KnowledgeJobResult = StudyResult | ConsolidateResult;

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
    @InjectQueue(KNOWLEDGE_JOBS_QUEUE_NAME)
    private readonly knowledgeQueue: Queue<KnowledgeJobData>,
  ) {
    super();
  }

  onModuleInit() {
    this.worker.concurrency = this.config.get<number>('queue.knowledgeConcurrency', 1);
  }

  async process(job: Job<KnowledgeJobData>): Promise<KnowledgeJobResult> {
    if (job.name === STUDY_DOCUMENT_JOB) {
      return this.studyDocument(job.data as StudyDocumentJobData);
    }
    if (job.name === CONSOLIDATE_CLIENT_JOB) {
      return this.consolidateClient(job.data as ConsolidateClientJobData);
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

    const skipped = planned.filter((note) => !pending.includes(note)).map((note) => note.kind);

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
    try {
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
    } finally {
      // O dossiê é refeito por causa do que já foi gravado, mesmo que a segunda
      // nota tenha falhado: o acervo mudou de qualquer jeito.
      if (generated.length > 0) await this.scheduleConsolidation(data.clientId);
    }

    return { documentId: data.documentId, generated, skipped };
  }

  /**
   * Refaz o dossiê do cliente quando o acervo dele mudou.
   *
   * A impressão digital do conjunto de notas é o que decide: consolidação
   * disparada por um arquivo que não mudou nada sai sem chamar o modelo. Cliente
   * que ficou sem acervo perde o dossiê, em vez de guardar um retrato de um
   * acervo que não existe mais.
   */
  private async consolidateClient(data: ConsolidateClientJobData): Promise<ConsolidateResult> {
    const notes = await this.knowledgeNotesService.listDocumentNotes(data.clientId);

    if (notes.length === 0) {
      const removed = await this.knowledgeNotesService.forgetClientNote(
        data.clientId,
        KnowledgeNoteKind.CLIENT_DOSSIER,
      );
      return { clientId: data.clientId, documents: 0, regenerated: removed > 0 };
    }

    const fingerprint = fingerprintClientNotes(notes);
    const model = this.noteGeneration.model;
    const provenance = {
      model,
      generatorVersion: CLIENT_DOSSIER_VERSION,
      sourceFingerprint: fingerprint,
    };

    const existing = await this.knowledgeNotesService.findClientNote(
      data.clientId,
      KnowledgeNoteKind.CLIENT_DOSSIER,
    );

    const documentos = dossierDocuments(
      notes,
      KnowledgeNoteKind.DOCUMENT_SUMMARY,
      this.config.get<number>('knowledge.dossierMaxDocuments', 25),
    );

    if (!noteNeedsRegeneration(existing, provenance)) {
      return { clientId: data.clientId, documents: documentos.length, regenerated: false };
    }

    const corpus = buildClientCorpus(
      documentos,
      this.config.get<number>('knowledge.excerptMaxChars', 12000),
    );

    if (!corpus) {
      throw new UnrecoverableError(
        `cliente ${data.clientId} não tem nenhum resumo de documento para consolidar`,
      );
    }

    let synthesis;
    try {
      synthesis = await this.noteGeneration.synthesizeClient({ clientId: data.clientId, corpus });
    } catch (error) {
      if (error instanceof InvalidNoteContentError) {
        this.logger.warn(`Síntese inválida do cliente ${data.clientId}: ${error.message}`);
        throw new UnrecoverableError(error.message);
      }
      throw error;
    }

    const dossier = assembleClientDossier({
      synthesis,
      brandGuide: brandGuideOf(notes, KnowledgeNoteKind.BRAND_GUIDE),
      documentos,
    });

    await this.knowledgeNotesService.saveClientNote({
      clientId: data.clientId,
      kind: KnowledgeNoteKind.CLIENT_DOSSIER,
      ...provenance,
      content: { ...dossier },
    });

    this.logger.log(
      `Dossiê do cliente ${data.clientId} refeito sobre ${documentos.length} documentos`,
    );

    return { clientId: data.clientId, documents: documentos.length, regenerated: true };
  }

  private async scheduleConsolidation(clientId: string): Promise<void> {
    try {
      await enqueueClientConsolidation(
        this.knowledgeQueue,
        clientId,
        this.config.get<number>('knowledge.dossierDelayMs', 60000),
      );
    } catch (error) {
      // As notas de documento já estão gravadas; derrubar o job aqui as faria
      // ser regeradas na repetição, e o dossiê volta na próxima mudança.
      this.logger.warn(
        `Não consegui enfileirar o dossiê de ${clientId}: ` +
          `${error instanceof Error ? error.message : error}`,
      );
    }
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
