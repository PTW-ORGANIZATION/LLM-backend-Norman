import { ConfigService } from '@nestjs/config';
import { Job, UnrecoverableError } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';
import { DocumentChunksService } from '../documents/document-chunks.service';
import { KnowledgeNote, KnowledgeNoteKind } from './knowledge-note.entity';
import { KnowledgeNotesService } from './knowledge-notes.service';
import { KnowledgeProcessor } from './knowledge.processor';
import { NoteGenerationService } from './note-generation.service';
import { InvalidNoteContentError } from './note-content';
import { STUDY_DOCUMENT_JOB, StudyDocumentJobData } from './knowledge-job-data.interface';

const MODEL = 'llama3.1:8b-instruct-q4_0';
const SHA = 'a'.repeat(64);

const JOB_DATA: StudyDocumentJobData = {
  documentId: 'doc-1',
  clientId: 'cli-vitalis',
  scopePath: 'Vitalis/01_Brand',
  filename: 'brand-guide.pdf',
  sha256: SHA,
};

const SUMMARY = {
  titulo: 'Brand guide da Vitalis',
  tipo: 'brand guide',
  idioma: 'pt',
  resumo: 'Define tom de voz e paleta.',
  topicos: ['tom de voz'],
  entidades: ['Vitalis'],
};

function buildProcessor(options: {
  chunks?: string[];
  existingNote?: Partial<KnowledgeNote> | null;
  summarize?: () => Promise<typeof SUMMARY>;
} = {}) {
  const config = {
    get: (key: string, fallback?: unknown) =>
      ({ 'knowledge.excerptMaxChars': 12000 } as Record<string, unknown>)[key] ?? fallback,
  } as unknown as ConfigService;

  const chunksService = {
    contentForDocument: vi.fn(async () => options.chunks ?? ['O tom de voz da Vitalis é direto.']),
  } as unknown as DocumentChunksService;

  const saved: unknown[] = [];
  const notesService = {
    findDocumentNote: vi.fn(async () => (options.existingNote ?? null) as KnowledgeNote | null),
    saveDocumentNote: vi.fn(async (note: unknown) => {
      saved.push(note);
      return note as KnowledgeNote;
    }),
  } as unknown as KnowledgeNotesService;

  const summarize = vi.fn(options.summarize ?? (async () => SUMMARY));
  const noteGeneration = {
    get model() {
      return MODEL;
    },
    summarizeDocument: summarize,
  } as unknown as NoteGenerationService;

  return {
    processor: new KnowledgeProcessor(config, chunksService, notesService, noteGeneration),
    chunksService,
    notesService,
    summarize,
    saved,
  };
}

function job(name: string, data: StudyDocumentJobData = JOB_DATA): Job<StudyDocumentJobData> {
  return { name, data } as Job<StudyDocumentJobData>;
}

describe('KnowledgeProcessor', () => {
  it('gera a nota e grava o modelo e a versão que a produziram', async () => {
    const { processor, saved, summarize } = buildProcessor();

    const result = await processor.process(job(STUDY_DOCUMENT_JOB));

    expect(result).toEqual({
      documentId: 'doc-1',
      kind: KnowledgeNoteKind.DOCUMENT_SUMMARY,
      regenerated: true,
    });
    expect(summarize).toHaveBeenCalledOnce();
    expect(saved[0]).toMatchObject({
      documentId: 'doc-1',
      clientId: 'cli-vitalis',
      scopePath: 'Vitalis/01_Brand',
      kind: KnowledgeNoteKind.DOCUMENT_SUMMARY,
      model: MODEL,
      generatorVersion: 1,
      sourceFingerprint: SHA,
      content: SUMMARY,
    });
  });

  it('não chama o modelo quando a nota já está em dia', async () => {
    const { processor, summarize, notesService } = buildProcessor({
      existingNote: { model: MODEL, generatorVersion: 1, sourceFingerprint: SHA },
    });

    const result = await processor.process(job(STUDY_DOCUMENT_JOB));

    expect(result.regenerated).toBe(false);
    expect(summarize).not.toHaveBeenCalled();
    expect(notesService.saveDocumentNote).not.toHaveBeenCalled();
  });

  it.each([
    ['o modelo mudou', { model: 'outro:7b', generatorVersion: 1, sourceFingerprint: SHA }],
    ['o prompt mudou', { model: MODEL, generatorVersion: 0, sourceFingerprint: SHA }],
    ['o arquivo mudou', { model: MODEL, generatorVersion: 1, sourceFingerprint: 'b'.repeat(64) }],
  ])('regera a nota quando %s', async (_label, existingNote) => {
    const { processor, summarize } = buildProcessor({ existingNote });

    expect((await processor.process(job(STUDY_DOCUMENT_JOB))).regenerated).toBe(true);
    expect(summarize).toHaveBeenCalledOnce();
  });

  it('documento sem chunks não vira nota e não repete', async () => {
    const { processor, summarize } = buildProcessor({ chunks: [] });

    await expect(processor.process(job(STUDY_DOCUMENT_JOB))).rejects.toThrow(UnrecoverableError);
    expect(summarize).not.toHaveBeenCalled();
  });

  it('nota inválida não é gravada nem repetida', async () => {
    const { processor, notesService } = buildProcessor({
      summarize: async () => {
        throw new InvalidNoteContentError('a nota veio sem "resumo"');
      },
    });

    await expect(processor.process(job(STUDY_DOCUMENT_JOB))).rejects.toThrow(UnrecoverableError);
    expect(notesService.saveDocumentNote).not.toHaveBeenCalled();
  });

  it('falha de infraestrutura continua sendo repetível', async () => {
    const { processor } = buildProcessor({
      summarize: async () => {
        throw new Error('Ollama /api/generate retornou 503');
      },
    });

    await expect(processor.process(job(STUDY_DOCUMENT_JOB))).rejects.not.toBeInstanceOf(
      UnrecoverableError,
    );
  });

  it('recusa job que não é desta fila', async () => {
    const { processor } = buildProcessor();

    await expect(processor.process(job('ingest-document'))).rejects.toThrow(UnrecoverableError);
  });
});
