import { ConfigService } from '@nestjs/config';
import { Job, UnrecoverableError } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';
import { DocumentChunksService } from '../documents/document-chunks.service';
import { KnowledgeNote, KnowledgeNoteKind } from './knowledge-note.entity';
import { KnowledgeNotesService } from './knowledge-notes.service';
import { KnowledgeProcessor } from './knowledge.processor';
import { NoteGenerationService } from './note-generation.service';
import { BrandGuideNote, DocumentSummary, InvalidNoteContentError } from './note-content';
import { STUDY_DOCUMENT_JOB, StudyDocumentJobData } from './knowledge-job-data.interface';

const MODEL = 'llama3.1:8b-instruct-q4_0';
const SHA = 'a'.repeat(64);

const JOB_DATA: StudyDocumentJobData = {
  documentId: 'doc-1',
  clientId: 'cli-vitalis',
  scopePath: 'Vitalis/03_Campanhas',
  filename: 'plano-de-midia.xlsx',
  sha256: SHA,
};

const BRAND_JOB_DATA: StudyDocumentJobData = {
  ...JOB_DATA,
  scopePath: 'Vitalis/01_Brand_Guide_Institucional',
  filename: 'manual.pdf',
};

const SUMMARY: DocumentSummary = {
  titulo: 'Plano de mídia',
  tipo: 'planilha de mídia',
  idioma: 'pt',
  resumo: 'Distribui a verba entre os canais.',
  topicos: ['verba'],
  entidades: ['Vitalis'],
};

const BRAND: BrandGuideNote = {
  tomDeVoz: 'Direto e caloroso.',
  publico: 'Cliente final.',
  fazer: ['falar simples'],
  evitar: ['jargão'],
  cores: [{ nome: 'verde Vitalis', hex: '#0F6B3D', uso: 'principal' }],
  tipografia: ['Inter'],
  restricoes: ['margem mínima de 2x'],
  proibicoes: ['distorcer o logotipo'],
};

function buildProcessor(
  options: {
    chunks?: string[];
    existingNotes?: Partial<Record<KnowledgeNoteKind, Partial<KnowledgeNote>>>;
    summarize?: () => Promise<DocumentSummary>;
    extractBrand?: () => Promise<BrandGuideNote>;
  } = {},
) {
  const config = {
    get: (key: string, fallback?: unknown) =>
      ({ 'knowledge.excerptMaxChars': 12000 } as Record<string, unknown>)[key] ?? fallback,
  } as unknown as ConfigService;

  const chunksService = {
    contentForDocument: vi.fn(async () => options.chunks ?? ['O tom de voz da Vitalis é direto.']),
  } as unknown as DocumentChunksService;

  const saved: Array<Record<string, unknown>> = [];
  const notesService = {
    findDocumentNote: vi.fn(
      async (_documentId: string, kind: KnowledgeNoteKind) =>
        (options.existingNotes?.[kind] ?? null) as KnowledgeNote | null,
    ),
    saveDocumentNote: vi.fn(async (note: Record<string, unknown>) => {
      saved.push(note);
      return note as unknown as KnowledgeNote;
    }),
  } as unknown as KnowledgeNotesService;

  const summarizeDocument = vi.fn(options.summarize ?? (async () => SUMMARY));
  const extractBrandGuide = vi.fn(options.extractBrand ?? (async () => BRAND));
  const noteGeneration = {
    get model() {
      return MODEL;
    },
    summarizeDocument,
    extractBrandGuide,
  } as unknown as NoteGenerationService;

  return {
    processor: new KnowledgeProcessor(config, chunksService, notesService, noteGeneration),
    chunksService,
    notesService,
    summarizeDocument,
    extractBrandGuide,
    saved,
  };
}

function job(name: string, data: StudyDocumentJobData = JOB_DATA): Job<StudyDocumentJobData> {
  return { name, data } as Job<StudyDocumentJobData>;
}

describe('KnowledgeProcessor — resumo por documento', () => {
  it('gera a nota e grava o modelo e a versão que a produziram', async () => {
    const { processor, saved, summarizeDocument } = buildProcessor();

    const result = await processor.process(job(STUDY_DOCUMENT_JOB));

    expect(result).toEqual({
      documentId: 'doc-1',
      generated: [KnowledgeNoteKind.DOCUMENT_SUMMARY],
      skipped: [],
    });
    expect(summarizeDocument).toHaveBeenCalledOnce();
    expect(saved[0]).toMatchObject({
      documentId: 'doc-1',
      clientId: 'cli-vitalis',
      scopePath: 'Vitalis/03_Campanhas',
      kind: KnowledgeNoteKind.DOCUMENT_SUMMARY,
      model: MODEL,
      generatorVersion: 1,
      sourceFingerprint: SHA,
      content: SUMMARY,
    });
  });

  it('não chama o modelo quando a nota já está em dia', async () => {
    const { processor, summarizeDocument, notesService } = buildProcessor({
      existingNotes: {
        [KnowledgeNoteKind.DOCUMENT_SUMMARY]: {
          model: MODEL,
          generatorVersion: 1,
          sourceFingerprint: SHA,
        },
      },
    });

    const result = await processor.process(job(STUDY_DOCUMENT_JOB));

    expect(result.generated).toEqual([]);
    expect(result.skipped).toEqual([KnowledgeNoteKind.DOCUMENT_SUMMARY]);
    expect(summarizeDocument).not.toHaveBeenCalled();
    expect(notesService.saveDocumentNote).not.toHaveBeenCalled();
  });

  it.each([
    ['o modelo mudou', { model: 'outro:7b', generatorVersion: 1, sourceFingerprint: SHA }],
    ['o prompt mudou', { model: MODEL, generatorVersion: 0, sourceFingerprint: SHA }],
    ['o arquivo mudou', { model: MODEL, generatorVersion: 1, sourceFingerprint: 'b'.repeat(64) }],
  ])('regera a nota quando %s', async (_label, existing) => {
    const { processor, summarizeDocument } = buildProcessor({
      existingNotes: { [KnowledgeNoteKind.DOCUMENT_SUMMARY]: existing },
    });

    const result = await processor.process(job(STUDY_DOCUMENT_JOB));

    expect(result.generated).toEqual([KnowledgeNoteKind.DOCUMENT_SUMMARY]);
    expect(summarizeDocument).toHaveBeenCalledOnce();
  });

  it('documento sem chunks não vira nota e não repete', async () => {
    const { processor, summarizeDocument } = buildProcessor({ chunks: [] });

    await expect(processor.process(job(STUDY_DOCUMENT_JOB))).rejects.toThrow(UnrecoverableError);
    expect(summarizeDocument).not.toHaveBeenCalled();
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

describe('KnowledgeProcessor — extração dirigida do brand guide', () => {
  it('documento comum não paga a extração dirigida', async () => {
    const { processor, extractBrandGuide } = buildProcessor();

    await processor.process(job(STUDY_DOCUMENT_JOB));

    expect(extractBrandGuide).not.toHaveBeenCalled();
  });

  it('brand guide ganha as duas notas', async () => {
    const { processor, saved, extractBrandGuide, summarizeDocument } = buildProcessor();

    const result = await processor.process(job(STUDY_DOCUMENT_JOB, BRAND_JOB_DATA));

    expect(result.generated).toEqual([
      KnowledgeNoteKind.DOCUMENT_SUMMARY,
      KnowledgeNoteKind.BRAND_GUIDE,
    ]);
    expect(summarizeDocument).toHaveBeenCalledOnce();
    expect(extractBrandGuide).toHaveBeenCalledOnce();
    expect(saved.map((note) => note.kind)).toEqual([
      KnowledgeNoteKind.DOCUMENT_SUMMARY,
      KnowledgeNoteKind.BRAND_GUIDE,
    ]);
    expect(saved[1].content).toEqual(BRAND);
  });

  it('o documento é lido do banco uma vez só para as duas notas', async () => {
    const { processor, chunksService } = buildProcessor();

    await processor.process(job(STUDY_DOCUMENT_JOB, BRAND_JOB_DATA));

    expect(chunksService.contentForDocument).toHaveBeenCalledOnce();
  });

  it('resumo em dia e ficha atrasada refazem só a ficha', async () => {
    const { processor, summarizeDocument, extractBrandGuide } = buildProcessor({
      existingNotes: {
        [KnowledgeNoteKind.DOCUMENT_SUMMARY]: {
          model: MODEL,
          generatorVersion: 1,
          sourceFingerprint: SHA,
        },
      },
    });

    const result = await processor.process(job(STUDY_DOCUMENT_JOB, BRAND_JOB_DATA));

    expect(result.generated).toEqual([KnowledgeNoteKind.BRAND_GUIDE]);
    expect(result.skipped).toEqual([KnowledgeNoteKind.DOCUMENT_SUMMARY]);
    expect(summarizeDocument).not.toHaveBeenCalled();
    expect(extractBrandGuide).toHaveBeenCalledOnce();
  });

  it('ficha ilegível não derruba o resumo que já foi gravado', async () => {
    const { processor, saved } = buildProcessor({
      extractBrand: async () => {
        throw new InvalidNoteContentError('sem tom de voz, sem cor e sem proibição');
      },
    });

    await expect(processor.process(job(STUDY_DOCUMENT_JOB, BRAND_JOB_DATA))).rejects.toThrow(
      UnrecoverableError,
    );
    expect(saved.map((note) => note.kind)).toEqual([KnowledgeNoteKind.DOCUMENT_SUMMARY]);
  });
});
