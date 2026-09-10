import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { Job, Queue } from 'bullmq';
import { ContentMismatchError, IngestionProcessor } from './ingestion.processor';
import type { IngestionJobData } from './ingestion-job-data.interface';
import type { KnowledgeJobData } from '../knowledge/knowledge-job-data.interface';

const SYSTEM_ROOT = '_Conhecimento geral do sistema';
const CONTEUDO = Buffer.from('conteudo');
const CONTEUDO_SHA256 = createHash('sha256').update(CONTEUDO).digest('hex');

/**
 * O nível do acervo atravessando a ingestão inteira.
 *
 * O que estas provas fecham é o transporte: se o nível se perdesse no meio do
 * caminho, um documento do acervo geral seria gravado como acervo de cliente
 * (ou o contrário), e nenhuma consulta encontraria o erro — ela devolveria a
 * camada errada em silêncio.
 */
function buildProcessor() {
  const config = { get: (_key: string, fallback?: unknown) => fallback } as any;
  const documentsService = {
    markProcessing: vi.fn(async () => undefined),
    markReady: vi.fn(async () => undefined),
    markFailed: vi.fn(async () => undefined),
    forgetPath: vi.fn(async () => 1),
  } as any;
  const chunksService = { replaceForDocument: vi.fn(async () => 1) } as any;
  const revocationsService = { isRevoked: vi.fn(async () => false) } as any;
  const textExtraction = {
    extract: vi.fn(async () => ({
      pages: [{ pageNumber: 1, text: 'o tom de voz do Norman e direto' }],
      source: 'pdf-text-layer',
    })),
  } as any;
  const ollamaService = { embedBatch: vi.fn(async (texts: string[]) => texts.map(() => [0.1])) } as any;
  const content = {
    fetch: vi.fn(async (request: { storagePath: string; filename: string }) => ({
      content: CONTEUDO,
      filename: request.filename,
      mimeType: 'application/pdf',
    })),
  } as any;
  const enqueued: Array<{ name: string; data: unknown }> = [];
  const knowledgeQueue = {
    add: async (name: string, data: unknown, opts: Record<string, unknown>) => {
      enqueued.push({ name, data });
      return { id: opts.jobId };
    },
  } as unknown as Queue<KnowledgeJobData>;

  return {
    processor: new IngestionProcessor(
      config,
      documentsService,
      chunksService,
      revocationsService,
      textExtraction,
      ollamaService,
      content,
      knowledgeQueue,
    ),
    documentsService,
    chunksService,
    revocationsService,
    content,
    enqueued,
  };
}

function job(data: IngestionJobData) {
  return { data } as unknown as Job<IngestionJobData>;
}

const GERAL: IngestionJobData = {
  documentId: 'doc-geral',
  knowledgeScope: 'system',
  clientId: null,
  scopePath: SYSTEM_ROOT,
  storagePath: `${SYSTEM_ROOT}/tom-de-voz.pdf`,
  filename: 'tom-de-voz.pdf',
  sha256: CONTEUDO_SHA256,
};

const DE_CLIENTE: IngestionJobData = {
  documentId: 'doc-cliente',
  knowledgeScope: 'client',
  clientId: 'cli-1',
  scopePath: 'Vitalis/01_Brand',
  storagePath: 'Vitalis/01_Brand/guia.pdf',
  filename: 'guia.pdf',
  sha256: CONTEUDO_SHA256,
};

describe('IngestionProcessor e o nível do acervo', () => {
  it('grava os chunks do acervo geral sem cliente', async () => {
    const { processor, chunksService } = buildProcessor();

    await processor.process(job(GERAL));

    expect(chunksService.replaceForDocument).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'system', clientId: null, scopePath: SYSTEM_ROOT }),
    );
  });

  it('busca os bytes declarando o nível, para o Norman conferir a propriedade', async () => {
    const { processor, content } = buildProcessor();

    await processor.process(job(GERAL));

    expect(content.fetch).toHaveBeenCalledWith({
      scope: 'system',
      clientId: null,
      storagePath: `${SYSTEM_ROOT}/tom-de-voz.pdf`,
      filename: 'tom-de-voz.pdf',
      expectedSha256: CONTEUDO_SHA256,
    });
  });

  it('a lápide consultada é a do nível do documento', async () => {
    const { processor, revocationsService } = buildProcessor();

    await processor.process(job(GERAL));

    expect(revocationsService.isRevoked).toHaveBeenCalledWith(
      null,
      `${SYSTEM_ROOT}/tom-de-voz.pdf`,
      'system',
    );
  });

  it('o estudo é enfileirado com o nível do documento', async () => {
    const { processor, enqueued } = buildProcessor();

    await processor.process(job(GERAL));

    expect(enqueued[0].data).toMatchObject({ knowledgeScope: 'system', clientId: null });
  });

  it('revogação geral descoberta no meio da ingestão descarta o documento geral', async () => {
    const { processor, revocationsService, documentsService, chunksService } = buildProcessor();
    revocationsService.isRevoked.mockResolvedValue(true);

    const result = await processor.process(job(GERAL));

    expect(result.chunks).toBe(0);
    expect(chunksService.replaceForDocument).not.toHaveBeenCalled();
    expect(documentsService.forgetPath).toHaveBeenCalledWith({
      scope: 'system',
      clientId: null,
      storagePath: `${SYSTEM_ROOT}/tom-de-voz.pdf`,
    });
  });

  it('o documento de cliente continua gravando o cliente', async () => {
    const { processor, chunksService, content } = buildProcessor();

    await processor.process(job(DE_CLIENTE));

    expect(chunksService.replaceForDocument).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'client', clientId: 'cli-1' }),
    );
    expect(content.fetch).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'client', clientId: 'cli-1' }),
    );
  });

  // Job antigo, enfileirado antes de o nível existir no payload: ele é de
  // cliente. Omissão não compartilha nada com ninguém.
  it('job sem nível declarado é tratado como acervo de cliente', async () => {
    const { processor, chunksService } = buildProcessor();
    const { knowledgeScope, ...antigo } = DE_CLIENTE;

    await processor.process(job(antigo as IngestionJobData));

    expect(chunksService.replaceForDocument).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'client', clientId: 'cli-1' }),
    );
  });
});

describe('a ingestão exige os bytes da geração declarada', () => {
  it('pede ao Norman o hash esperado junto do caminho', async () => {
    const { processor, content } = buildProcessor();

    await processor.process(job(DE_CLIENTE));

    expect(content.fetch).toHaveBeenCalledWith(expect.objectContaining({
      expectedSha256: CONTEUDO_SHA256,
    }));
  });

  it('recusa bytes de outra versão e marca o documento como falho', async () => {
    const { processor, documentsService } = buildProcessor();

    await expect(processor.process(job({ ...DE_CLIENTE, sha256: 'a'.repeat(64) })))
      .rejects.toThrow(/devolveu bytes de outra versão/);

    expect(documentsService.markReady).not.toHaveBeenCalled();
    expect(documentsService.markFailed).toHaveBeenCalledWith(
      'doc-cliente',
      expect.stringContaining('devolveu bytes de outra versão'),
    );
  });

  it('a divergência de conteúdo continua repetível, porque o storage pode confirmar depois', async () => {
    const { processor } = buildProcessor();

    const erro = await processor
      .process(job({ ...DE_CLIENTE, sha256: 'a'.repeat(64) }))
      .catch((error: Error) => error);

    expect(erro).toBeInstanceOf(ContentMismatchError);
    expect((erro as Error).name).not.toBe('UnrecoverableError');
  });

  it('não vetoriza nada quando os bytes divergem', async () => {
    const { processor, chunksService } = buildProcessor();

    await processor.process(job({ ...DE_CLIENTE, sha256: 'a'.repeat(64) })).catch(() => undefined);

    expect(chunksService.replaceForDocument).not.toHaveBeenCalled();
  });
});
