import { describe, expect, it, vi } from 'vitest';
import { InternalDocumentsController } from './internal-documents.controller';
import { InternalKnowledgeController } from './internal-knowledge.controller';

const SYSTEM_ROOT = '_Conhecimento geral do sistema';

function buildDocumentsController() {
  const documentsService = {
    registerClientDocument: vi.fn(async () => ({
      document: { id: 'doc-geral', status: 'pending' },
      changed: true,
    })),
    forgetPath: vi.fn(async () => 1),
    forgetPrefix: vi.fn(async () => 2),
    renamePrefix: vi.fn(async () => 3),
    findById: vi.fn(async () => null),
  } as any;
  const revocationsService = {
    revokePath: vi.fn(async () => ({ removed: 1, tombstones: 1 })),
    revokePrefix: vi.fn(async () => ({ removed: 2, tombstones: 1 })),
    isRevoked: vi.fn(async () => false),
    lift: vi.fn(async () => 1),
  } as any;
  const knowledgeNotesService = { markClientNotesStale: vi.fn(async () => 1) } as any;
  const ingestionQueue = { add: vi.fn(async () => ({ id: 'job-1' })) } as any;
  const knowledgeQueue = { add: vi.fn(async () => ({ id: 'job-2' })) } as any;

  return {
    controller: new InternalDocumentsController(
      { get: (_key: string, fallback?: unknown) => fallback } as any,
      documentsService,
      revocationsService,
      knowledgeNotesService,
      ingestionQueue,
      knowledgeQueue,
    ),
    documentsService,
    revocationsService,
    knowledgeNotesService,
    ingestionQueue,
    knowledgeQueue,
  };
}

function buildKnowledgeController(overrides: {
  systemDocuments?: unknown[];
  systemNotes?: unknown[];
  document?: unknown;
  snippets?: Array<{ content: string }>;
} = {}) {
  const chunksService = {
    searchSimilar: vi.fn(async () => (overrides.snippets ?? []).map((snippet, index) => ({
      knowledgeScope: 'system',
      documentId: `doc-${index}`,
      filename: 'manual.pdf',
      storagePath: `${SYSTEM_ROOT}/manual.pdf`,
      scopePath: SYSTEM_ROOT,
      chunkIndex: index,
      pageNumber: 1,
      embeddingModel: 'nomic-embed-text',
      distance: 0.1,
      similarity: 0.9,
      ...snippet,
    }))),
  } as any;
  const notesService = {
    listScopeStatus: vi.fn(async () => []),
    listSystemDocuments: vi.fn(async () => overrides.systemDocuments ?? []),
    listSystemNoteDetails: vi.fn(async () => overrides.systemNotes ?? []),
    findClientNote: vi.fn(async () => null),
    listClientDocuments: vi.fn(async () => []),
    listDocumentNoteDetails: vi.fn(async () => []),
  } as any;
  const documentsService = {
    findByScopePath: vi.fn(async () => overrides.document ?? null),
    markPending: vi.fn(async () => undefined),
  } as any;
  const ingestionQueue = {
    add: vi.fn(async () => ({ id: 'job-1' })),
    remove: vi.fn(async () => 1),
  } as any;
  const knowledgeQueue = {
    add: vi.fn(async () => ({ id: 'job-2' })),
    remove: vi.fn(async () => 1),
    getJob: vi.fn(async () => undefined),
  } as any;

  return {
    controller: new InternalKnowledgeController(
      { get: (_key: string, fallback?: unknown) => fallback ?? 'nomic-embed-text' } as any,
      chunksService,
      documentsService,
      { embed: vi.fn(async () => [0.1, 0.2, 0.3]) } as any,
      notesService,
      { extract: vi.fn() } as any,
      ingestionQueue,
      knowledgeQueue,
    ),
    chunksService,
    notesService,
    documentsService,
    ingestionQueue,
  };
}

const REGISTRO_GERAL = {
  scope: 'system' as const,
  scopePath: SYSTEM_ROOT,
  storagePath: `${SYSTEM_ROOT}/manual.pdf`,
  filename: 'manual.pdf',
  sha256: 'a'.repeat(64),
};

describe('acervo geral do sistema nas rotas internas', () => {
  it('o registro geral não leva cliente para o serviço nem para a fila', async () => {
    const { controller, documentsService, ingestionQueue } = buildDocumentsController();

    await controller.register(REGISTRO_GERAL as any);

    expect(documentsService.registerClientDocument).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'system', clientId: null }),
    );
    expect(ingestionQueue.add.mock.calls[0][1]).toMatchObject({
      knowledgeScope: 'system',
      clientId: null,
    });
  });

  it('o registro de cliente continua levando o cliente', async () => {
    const { controller, documentsService, ingestionQueue } = buildDocumentsController();

    await controller.register({
      clientId: 'cli-1',
      scopePath: 'Vitalis/01_Brand',
      storagePath: 'Vitalis/01_Brand/guia.pdf',
      filename: 'guia.pdf',
      sha256: 'b'.repeat(64),
    } as any);

    expect(documentsService.registerClientDocument).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'client', clientId: 'cli-1' }),
    );
    expect(ingestionQueue.add.mock.calls[0][1]).toMatchObject({
      knowledgeScope: 'client',
      clientId: 'cli-1',
    });
  });

  it('a lápide levantada pelo envio administrativo geral é a do acervo geral', async () => {
    const { controller, revocationsService } = buildDocumentsController();

    await controller.register({ ...REGISTRO_GERAL, origin: 'administrative' } as any);

    expect(revocationsService.lift).toHaveBeenCalledWith(
      null,
      `${SYSTEM_ROOT}/manual.pdf`,
      'system',
    );
    expect(revocationsService.isRevoked).toHaveBeenCalledWith(
      null,
      `${SYSTEM_ROOT}/manual.pdf`,
      'system',
    );
  });

  // O acervo geral não tem dossiê consolidado: a remoção física dos chunks já é
  // o que faz a fonte parar de aparecer para todos os clientes, e não há nota
  // de cliente derivada dela para marcar.
  it('revogar no acervo geral não marca dossiê de cliente nenhum', async () => {
    const { controller, knowledgeNotesService, knowledgeQueue } = buildDocumentsController();

    const resposta = await controller.forgetPath({
      scope: 'system',
      storagePath: `${SYSTEM_ROOT}/manual.pdf`,
    } as any);

    expect(resposta).toEqual({
      scope: 'system',
      removed: 1,
      revocationState: 'confirmed',
      tombstones: 1,
      invalidated: 0,
      reconsolidationQueued: false,
    });
    expect(knowledgeNotesService.markClientNotesStale).not.toHaveBeenCalled();
    expect(knowledgeQueue.add).not.toHaveBeenCalled();
  });

  it('revogar uma pasta do acervo geral usa o nível geral no serviço', async () => {
    const { controller, revocationsService } = buildDocumentsController();

    await controller.forgetPrefix({
      scope: 'system',
      scopePath: `${SYSTEM_ROOT}/Rascunhos`,
    } as any);

    expect(revocationsService.revokePrefix).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'system', clientId: null }),
    );
  });

  it('renomear pasta do acervo geral não inventa dono', async () => {
    const { controller, documentsService } = buildDocumentsController();

    await controller.renamePrefix({
      scope: 'system',
      fromPath: `${SYSTEM_ROOT}/Antigo`,
      toPath: `${SYSTEM_ROOT}/Novo`,
    } as any);

    expect(documentsService.renamePrefix).toHaveBeenCalledWith({
      scope: 'system',
      clientId: null,
      fromPath: `${SYSTEM_ROOT}/Antigo`,
      toPath: `${SYSTEM_ROOT}/Novo`,
    });
  });

  it('a busca no acervo geral usa o escopo do sistema, sem cliente', async () => {
    const { controller, chunksService } = buildKnowledgeController({
      snippets: [{ content: 'o tom de voz do Norman é direto' }],
    });

    const resultado = await controller.search({
      scope: 'system',
      question: 'qual é o tom de voz?',
    } as any);

    expect(chunksService.searchSimilar.mock.calls[0][0].scope).toEqual({
      kind: 'system',
      excludeScopePaths: undefined,
    });
    expect(resultado.scope).toBe('system');
    expect(resultado.snippets).toHaveLength(1);
  });

  it('a busca de cliente continua travada no cliente', async () => {
    const { controller, chunksService } = buildKnowledgeController();

    await controller.search({ clientId: 'cli-1', question: 'oi' } as any);

    expect(chunksService.searchSimilar.mock.calls[0][0].scope).toMatchObject({
      kind: 'client',
      clientId: 'cli-1',
    });
  });

  it('o estado de ingestão do acervo geral consulta o nível geral', async () => {
    const { controller, notesService } = buildKnowledgeController();

    const resultado = await controller.scopeStatus({
      scope: 'system',
      scopePath: SYSTEM_ROOT,
    } as any);

    expect(notesService.listScopeStatus).toHaveBeenCalledWith({
      scope: 'system',
      clientId: null,
      scopePath: SYSTEM_ROOT,
    });
    expect(resultado.scope).toBe('system');
  });

  it('a visão do acervo geral traz documentos e notas, e nenhum dossiê', async () => {
    const { controller } = buildKnowledgeController({
      systemDocuments: [{ documentId: 'doc-1', filename: 'manual.pdf', status: 'ready' }],
      systemNotes: [{
        documentId: 'doc-1',
        kind: 'document_summary',
        content: { resumo: 'tom direto' },
        model: 'llama3.1:8b',
        generatorVersion: 2,
        updatedAt: new Date('2026-09-09T00:00:00Z'),
      }],
    });

    const resultado = await controller.systemOverview({} as any);

    expect(resultado).toMatchObject({ scope: 'system' });
    expect(resultado).not.toHaveProperty('dossier');
    expect(resultado.documents[0]).toMatchObject({
      documentId: 'doc-1',
      notes: [expect.objectContaining({ kind: 'document_summary' })],
    });
  });

  it('reprocessar no acervo geral procura o documento pelo nível geral', async () => {
    const { controller, documentsService, ingestionQueue } = buildKnowledgeController({
      document: {
        id: 'doc-geral',
        sha256: 'c'.repeat(64),
        scopePath: SYSTEM_ROOT,
        storagePath: `${SYSTEM_ROOT}/manual.pdf`,
        filename: 'manual.pdf',
      },
    });

    await controller.reprocessDocument({
      scope: 'system',
      storagePath: `${SYSTEM_ROOT}/manual.pdf`,
    } as any);

    expect(documentsService.findByScopePath).toHaveBeenCalledWith(
      'system',
      null,
      `${SYSTEM_ROOT}/manual.pdf`,
    );
    expect(ingestionQueue.add.mock.calls[0][1]).toMatchObject({
      knowledgeScope: 'system',
      clientId: null,
    });
  });

  it('reprocessar caminho que não está no acervo geral diz isso', async () => {
    const { controller } = buildKnowledgeController();

    await expect(
      controller.reprocessDocument({
        scope: 'system',
        storagePath: `${SYSTEM_ROOT}/inexistente.pdf`,
      } as any),
    ).rejects.toThrow(/acervo geral do sistema/);
  });
});
