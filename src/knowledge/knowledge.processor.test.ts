import { ConfigService } from '@nestjs/config';
import { Job, UnrecoverableError } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';
import { DocumentChunksService } from '../documents/document-chunks.service';
import { KnowledgeNote, KnowledgeNoteKind } from './knowledge-note.entity';
import { KnowledgeNotesService } from './knowledge-notes.service';
import { ConsolidateResult, KnowledgeProcessor, StudyResult } from './knowledge.processor';
import { NoteGenerationService } from './note-generation.service';
import { BrandGuideNote, DocumentSummary, InvalidNoteContentError } from './note-content';
import { CLIENT_DOSSIER_VERSION, ClientSynthesis, DocumentNoteRow } from './client-dossier';
import { DOCUMENT_SUMMARY_VERSION } from './note-content';
import {
  CONSOLIDATE_CLIENT_JOB,
  KnowledgeJobData,
  STUDY_DOCUMENT_JOB,
  StudyDocumentJobData,
} from './knowledge-job-data.interface';
import { Queue } from 'bullmq';

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
  identificadores: [],
};

const SYNTHESIS: ClientSynthesis = {
  resumo: 'Cliente de saúde que faz campanhas sazonais.',
  setor: 'saúde',
  temasRecorrentes: ['verão'],
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
    clientNotes?: DocumentNoteRow[];
    summarize?: () => Promise<DocumentSummary>;
    extractBrand?: () => Promise<BrandGuideNote>;
    synthesize?: () => Promise<ClientSynthesis>;
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
  const savedDossiers: Array<Record<string, unknown>> = [];
  const notesService = {
    findDocumentNote: vi.fn(
      async (_documentId: string, kind: KnowledgeNoteKind) =>
        (options.existingNotes?.[kind] ?? null) as KnowledgeNote | null,
    ),
    findClientNote: vi.fn(
      async (_clientId: string, kind: KnowledgeNoteKind) =>
        (options.existingNotes?.[kind] ?? null) as KnowledgeNote | null,
    ),
    listDocumentNotes: vi.fn(async () => options.clientNotes ?? []),
    forgetClientNote: vi.fn(async () => 1),
    saveDocumentNote: vi.fn(async (note: Record<string, unknown>) => {
      saved.push(note);
      return note as unknown as KnowledgeNote;
    }),
    saveClientNote: vi.fn(async (note: Record<string, unknown>) => {
      savedDossiers.push(note);
      return note as unknown as KnowledgeNote;
    }),
  } as unknown as KnowledgeNotesService;

  const summarizeDocument = vi.fn(options.summarize ?? (async () => SUMMARY));
  const extractBrandGuide = vi.fn(options.extractBrand ?? (async () => BRAND));
  const synthesizeClient = vi.fn(options.synthesize ?? (async () => SYNTHESIS));
  const noteGeneration = {
    get model() {
      return MODEL;
    },
    summarizeDocument,
    extractBrandGuide,
    synthesizeClient,
  } as unknown as NoteGenerationService;

  const enqueued: Array<{ name: string; data: unknown; opts: Record<string, unknown> }> = [];
  const queue = {
    add: async (name: string, data: unknown, opts: Record<string, unknown>) => {
      enqueued.push({ name, data, opts });
      return { id: opts.jobId };
    },
  } as unknown as Queue<KnowledgeJobData>;

  return {
    processor: new KnowledgeProcessor(
      config,
      chunksService,
      notesService,
      noteGeneration,
      queue,
    ),
    enqueued,
    chunksService,
    notesService,
    summarizeDocument,
    extractBrandGuide,
    synthesizeClient,
    saved,
    savedDossiers,
  };
}

function job(name: string, data: unknown = JOB_DATA): Job<KnowledgeJobData> {
  return { name, data } as Job<KnowledgeJobData>;
}

async function study(
  processor: KnowledgeProcessor,
  data: StudyDocumentJobData = JOB_DATA,
): Promise<StudyResult> {
  return (await processor.process(job(STUDY_DOCUMENT_JOB, data))) as StudyResult;
}

async function consolidate(
  processor: KnowledgeProcessor,
  clientId = 'cli-vitalis',
): Promise<ConsolidateResult> {
  return (await processor.process(
    job(CONSOLIDATE_CLIENT_JOB, { clientId }),
  )) as ConsolidateResult;
}

describe('KnowledgeProcessor — resumo por documento', () => {
  it('gera a nota e grava o modelo e a versão que a produziram', async () => {
    const { processor, saved, summarizeDocument } = buildProcessor();

    const result = await study(processor);

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
      generatorVersion: DOCUMENT_SUMMARY_VERSION,
      sourceFingerprint: SHA,
      content: SUMMARY,
    });
  });

  it('não chama o modelo quando a nota já está em dia', async () => {
    const { processor, summarizeDocument, notesService } = buildProcessor({
      existingNotes: {
        [KnowledgeNoteKind.DOCUMENT_SUMMARY]: {
          model: MODEL,
          generatorVersion: DOCUMENT_SUMMARY_VERSION,
          sourceFingerprint: SHA,
        },
      },
    });

    const result = await study(processor);

    expect(result.generated).toEqual([]);
    expect(result.skipped).toEqual([KnowledgeNoteKind.DOCUMENT_SUMMARY]);
    expect(summarizeDocument).not.toHaveBeenCalled();
    expect(notesService.saveDocumentNote).not.toHaveBeenCalled();
  });

  it.each([
    ['o modelo mudou', { model: 'outro:7b', generatorVersion: DOCUMENT_SUMMARY_VERSION, sourceFingerprint: SHA }],
    ['o prompt mudou', { model: MODEL, generatorVersion: DOCUMENT_SUMMARY_VERSION - 1, sourceFingerprint: SHA }],
    ['o arquivo mudou', { model: MODEL, generatorVersion: DOCUMENT_SUMMARY_VERSION, sourceFingerprint: 'b'.repeat(64) }],
  ])('regera a nota quando %s', async (_label, existing) => {
    const { processor, summarizeDocument } = buildProcessor({
      existingNotes: { [KnowledgeNoteKind.DOCUMENT_SUMMARY]: existing },
    });

    const result = await study(processor);

    expect(result.generated).toEqual([KnowledgeNoteKind.DOCUMENT_SUMMARY]);
    expect(summarizeDocument).toHaveBeenCalledOnce();
  });

  it('documento sem chunks não vira nota e não repete', async () => {
    const { processor, summarizeDocument } = buildProcessor({ chunks: [] });

    await expect(study(processor)).rejects.toThrow(UnrecoverableError);
    expect(summarizeDocument).not.toHaveBeenCalled();
  });

  it('nota inválida não é gravada nem repetida', async () => {
    const { processor, notesService } = buildProcessor({
      summarize: async () => {
        throw new InvalidNoteContentError('a nota veio sem "resumo"');
      },
    });

    await expect(study(processor)).rejects.toThrow(UnrecoverableError);
    expect(notesService.saveDocumentNote).not.toHaveBeenCalled();
  });

  it('falha de infraestrutura continua sendo repetível', async () => {
    const { processor } = buildProcessor({
      summarize: async () => {
        throw new Error('Ollama /api/generate retornou 503');
      },
    });

    await expect(study(processor)).rejects.not.toBeInstanceOf(
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

    await study(processor);

    expect(extractBrandGuide).not.toHaveBeenCalled();
  });

  it('brand guide ganha as duas notas', async () => {
    const { processor, saved, extractBrandGuide, summarizeDocument } = buildProcessor();

    const result = await study(processor, BRAND_JOB_DATA);

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

    await study(processor, BRAND_JOB_DATA);

    expect(chunksService.contentForDocument).toHaveBeenCalledOnce();
  });

  it('resumo em dia e ficha atrasada refazem só a ficha', async () => {
    const { processor, summarizeDocument, extractBrandGuide } = buildProcessor({
      existingNotes: {
        [KnowledgeNoteKind.DOCUMENT_SUMMARY]: {
          model: MODEL,
          generatorVersion: DOCUMENT_SUMMARY_VERSION,
          sourceFingerprint: SHA,
        },
      },
    });

    const result = await study(processor, BRAND_JOB_DATA);

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

    await expect(study(processor, BRAND_JOB_DATA)).rejects.toThrow(UnrecoverableError);
    expect(saved.map((note) => note.kind)).toEqual([KnowledgeNoteKind.DOCUMENT_SUMMARY]);
  });
});

describe('KnowledgeProcessor — dossiê do cliente', () => {
  function clientNote(overrides: Partial<DocumentNoteRow> = {}): DocumentNoteRow {
    return {
      documentId: 'doc-1',
      kind: KnowledgeNoteKind.DOCUMENT_SUMMARY,
      filename: 'briefing.pdf',
      scopePath: 'Vitalis/03_Campanhas',
      sourceFingerprint: SHA,
      content: { ...SUMMARY },
      ...overrides,
    };
  }

  it('consolida o acervo num dossiê com a marca copiada da ficha', async () => {
    const { processor, savedDossiers, synthesizeClient } = buildProcessor({
      clientNotes: [
        clientNote(),
        clientNote({
          documentId: 'doc-2',
          kind: KnowledgeNoteKind.BRAND_GUIDE,
          filename: 'manual.pdf',
          scopePath: 'Vitalis/01_Brand_Guide_Institucional',
          content: { ...BRAND },
        }),
      ],
    });

    const result = await consolidate(processor);

    expect(result).toMatchObject({ clientId: 'cli-vitalis', documents: 1, regenerated: true });
    expect(synthesizeClient).toHaveBeenCalledOnce();
    expect(savedDossiers[0]).toMatchObject({
      clientId: 'cli-vitalis',
      kind: KnowledgeNoteKind.CLIENT_DOSSIER,
      model: MODEL,
      generatorVersion: CLIENT_DOSSIER_VERSION,
    });
    expect(savedDossiers[0].content).toMatchObject({
      resumo: SYNTHESIS.resumo,
      setor: 'saúde',
      tomDeVoz: BRAND.tomDeVoz,
      cores: BRAND.cores,
      proibicoes: BRAND.proibicoes,
    });
  });

  it('acervo que não mudou não chama o modelo', async () => {
    const notes = [clientNote()];
    const { processor: primeiro, savedDossiers } = buildProcessor({ clientNotes: notes });
    await consolidate(primeiro);

    const { processor, synthesizeClient } = buildProcessor({
      clientNotes: notes,
      existingNotes: {
        [KnowledgeNoteKind.CLIENT_DOSSIER]: {
          model: MODEL,
          generatorVersion: CLIENT_DOSSIER_VERSION,
          sourceFingerprint: savedDossiers[0].sourceFingerprint as string,
        },
      },
    });

    const result = await consolidate(processor);

    expect(result.regenerated).toBe(false);
    expect(synthesizeClient).not.toHaveBeenCalled();
  });

  it('cliente que ficou sem acervo perde o dossiê', async () => {
    const { processor, notesService, synthesizeClient } = buildProcessor({ clientNotes: [] });

    const result = await consolidate(processor);

    expect(result).toEqual({ clientId: 'cli-vitalis', documents: 0, regenerated: true });
    expect(notesService.forgetClientNote).toHaveBeenCalledWith(
      'cli-vitalis',
      KnowledgeNoteKind.CLIENT_DOSSIER,
    );
    expect(synthesizeClient).not.toHaveBeenCalled();
  });

  it('estudar um documento agenda a consolidação, com id fixo por cliente', async () => {
    const { processor, enqueued } = buildProcessor();

    await study(processor);

    expect(enqueued).toEqual([
      {
        name: CONSOLIDATE_CLIENT_JOB,
        data: { clientId: 'cli-vitalis' },
        opts: expect.objectContaining({ jobId: 'dossier-cli-vitalis', removeOnComplete: true }),
      },
    ]);
  });

  it('nota que não precisou ser refeita não agenda consolidação', async () => {
    const { processor, enqueued } = buildProcessor({
      existingNotes: {
        [KnowledgeNoteKind.DOCUMENT_SUMMARY]: {
          model: MODEL,
          generatorVersion: DOCUMENT_SUMMARY_VERSION,
          sourceFingerprint: SHA,
        },
      },
    });

    await study(processor);

    expect(enqueued).toEqual([]);
  });

  it('síntese inválida não vira dossiê nem repete', async () => {
    const { processor, notesService } = buildProcessor({
      clientNotes: [clientNote()],
      synthesize: async () => {
        throw new InvalidNoteContentError('a síntese do cliente veio sem "resumo"');
      },
    });

    await expect(consolidate(processor)).rejects.toThrow(UnrecoverableError);
    expect(notesService.saveClientNote).not.toHaveBeenCalled();
  });
});
