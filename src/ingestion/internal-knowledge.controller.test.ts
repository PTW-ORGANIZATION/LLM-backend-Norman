import { describe, expect, it, vi } from 'vitest';
import { InternalKnowledgeController } from './internal-knowledge.controller';

interface ControllerOverrides {
  clientDocuments?: unknown[];
  noteDetails?: unknown[];
  document?: unknown;
  dossierJob?: unknown;
}

function buildController(
  snippets: Array<{ content: string }> = [],
  scopeStatus: unknown[] = [],
  clientNote: unknown = null,
  overrides: ControllerOverrides = {},
) {
  const chunksService = {
    searchSimilar: vi.fn(async () => snippets.map((snippet, index) => ({
      documentId: `doc-${index}`,
      filename: 'guia.pdf',
      storagePath: 'Vitalis/01_Brand/guia.pdf',
      scopePath: 'Vitalis/01_Brand',
      chunkIndex: index,
      pageNumber: 1,
      embeddingModel: 'nomic-embed-text',
      distance: 0.1,
      similarity: 0.9,
      ...snippet,
    }))),
  } as any;
  const ollamaService = { embed: vi.fn(async () => [0.1, 0.2, 0.3]) } as any;
  const notesService = {
    listScopeStatus: vi.fn(async () => scopeStatus),
    findClientNote: vi.fn(async () => clientNote),
    listClientDocuments: vi.fn(async () => overrides.clientDocuments ?? []),
    listDocumentNoteDetails: vi.fn(async () => overrides.noteDetails ?? []),
  } as any;
  const documentsService = {
    findByScopePath: vi.fn(async () => overrides.document ?? null),
    markPending: vi.fn(async () => undefined),
  } as any;
  const textExtractionService = {
    extract: vi.fn(async () => ({
      pages: [{ pageNumber: 1, text: 'conteúdo extraído pelo LLM-backend' }],
      source: 'pptx',
    })),
  } as any;
  const ingestionQueue = {
    add: vi.fn(async () => ({ id: 'job-1' })),
    remove: vi.fn(async () => 1),
  } as any;
  const knowledgeQueue = {
    add: vi.fn(async () => ({ id: 'job-2' })),
    remove: vi.fn(async () => 1),
    getJob: vi.fn(async () => overrides.dossierJob),
  } as any;

  return {
    controller: new InternalKnowledgeController(
      { get: (_key: string, fallback?: unknown) => fallback ?? 'nomic-embed-text' } as any,
      chunksService,
      documentsService,
      ollamaService,
      notesService,
      textExtractionService,
      ingestionQueue,
      knowledgeQueue,
    ),
    chunksService,
    ollamaService,
    notesService,
    documentsService,
    textExtractionService,
    ingestionQueue,
    knowledgeQueue,
  };
}

describe('InternalKnowledgeController.extractDocument', () => {
  it('extrai o arquivo no LLM-backend e devolve o texto consolidado', async () => {
    const { controller, textExtractionService } = buildController();
    await expect(
      controller.extractDocument({
        buffer: Buffer.from('arquivo'),
        originalname: 'briefing.pptx',
        mimetype: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      }),
    ).resolves.toEqual({ text: 'conteúdo extraído pelo LLM-backend', source: 'pptx' });

    expect(textExtractionService.extract).toHaveBeenCalledWith({
      content: Buffer.from('arquivo'),
      filename: 'briefing.pptx',
      mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    });
  });

  it('separa as páginas no texto devolvido ao Norman', async () => {
    const { controller, textExtractionService } = buildController();
    textExtractionService.extract.mockResolvedValue({
      pages: [
        { pageNumber: 1, text: 'primeira página' },
        { pageNumber: 2, text: 'segunda página' },
      ],
      source: 'pdf-text-layer',
    });

    const result = await controller.extractDocument({
      buffer: Buffer.from('arquivo'),
      originalname: 'briefing.pdf',
      mimetype: 'application/pdf',
    });

    expect(result.text).toBe('primeira página\n\nsegunda página');
  });

  it('recusa pedido sem arquivo', async () => {
    const { controller } = buildController();

    await expect(controller.extractDocument()).rejects.toThrow('arquivo é obrigatório');
  });

  it('recusa áudio declarado, sem chamar a extração', async () => {
    const { controller, textExtractionService } = buildController();

    await expect(
      controller.extractDocument({
        buffer: Buffer.from('conteúdo qualquer que seja grande o bastante'),
        originalname: 'reuniao.ogg',
        mimetype: 'audio/ogg',
      }),
    ).rejects.toThrow('áudio não é aceito aqui');
    expect(textExtractionService.extract).not.toHaveBeenCalled();
  });

  it('recusa áudio disfarçado de documento, pelo conteúdo', async () => {
    const { controller, textExtractionService } = buildController();
    const audio = Buffer.alloc(64);
    audio.write('OggS', 0, 'latin1');

    await expect(
      controller.extractDocument({
        buffer: audio,
        originalname: 'briefing.pdf',
        mimetype: 'application/pdf',
      }),
    ).rejects.toThrow('o conteúdo enviado é áudio');
    expect(textExtractionService.extract).not.toHaveBeenCalled();
  });
});

describe('InternalKnowledgeController.search', () => {
  it('embeda a pergunta e busca no escopo de cliente', async () => {
    const { controller, chunksService, ollamaService } = buildController([{ content: 'tom direto' }]);

    const result = await controller.search({
      clientId: 'cli-1',
      scopePath: 'Vitalis/01_Brand',
      question: 'qual é o tom de voz?',
    });

    expect(ollamaService.embed).toHaveBeenCalledWith('qual é o tom de voz?');
    expect(chunksService.searchSimilar).toHaveBeenCalledWith({
      scope: {
        kind: 'client',
        clientId: 'cli-1',
        scopePath: 'Vitalis/01_Brand',
        includeDescendants: undefined,
      },
      embedding: [0.1, 0.2, 0.3],
      embeddingModel: 'nomic-embed-text',
    });
    expect(result.snippets).toEqual([expect.objectContaining({
      content: 'tom direto',
      documentId: 'doc-0',
      filename: 'guia.pdf',
      storagePath: 'Vitalis/01_Brand/guia.pdf',
      chunkIndex: 0,
      pageNumber: 1,
      similarity: 0.9,
    })]);
    expect(result.evidence).toMatchObject({ considered: 1, used: 1, sufficient: true });
  });

  // O escopo de pessoa é o do chat de hoje e recupera de outra família de linhas;
  // esta rota nunca pode cair nele.
  it('não recupera vetor gerado por outro modelo de embedding', async () => {
    const { controller, chunksService } = buildController();

    await controller.search({ clientId: 'cli-1', scopePath: 'Vitalis', question: 'oi' });

    expect(chunksService.searchSimilar.mock.calls[0][0].embeddingModel).toBe('nomic-embed-text');
  });

  it('nunca busca no escopo de pessoa', async () => {
    const { controller, chunksService } = buildController();

    await controller.search({ clientId: 'cli-1', scopePath: 'Vitalis', question: 'oi' });

    expect(chunksService.searchSimilar.mock.calls[0][0].scope.kind).toBe('client');
  });

  it('acervo sem nada pertinente devolve lista vazia e evidência insuficiente', async () => {
    const { controller } = buildController();

    const result = await controller.search({ clientId: 'cli-1', scopePath: 'Vitalis', question: 'oi' });

    expect(result.snippets).toEqual([]);
    expect(result.evidence).toMatchObject({
      considered: 0,
      used: 0,
      bestSimilarity: null,
      sufficient: false,
    });
  });

  it('trecho pouco parecido com a pergunta não vira contexto', async () => {
    const { controller, chunksService } = buildController();
    chunksService.searchSimilar.mockResolvedValue([{
      content: 'nada a ver com a pergunta',
      documentId: 'doc-1',
      filename: 'outro.pdf',
      storagePath: 'Vitalis/outro.pdf',
      scopePath: 'Vitalis',
      chunkIndex: 0,
      pageNumber: null,
      embeddingModel: 'nomic-embed-text',
      distance: 0.98,
      similarity: 0.02,
    }]);

    const result = await controller.search({ clientId: 'cli-1', scopePath: 'Vitalis', question: 'oi' });

    expect(result.snippets).toEqual([]);
    expect(result.evidence).toMatchObject({ discardedByRelevance: 1, sufficient: false });
  });
});

describe('InternalKnowledgeController.scopeStatus', () => {
  it('devolve o estado de cada arquivo da pasta pedida', async () => {
    const linha = {
      storagePath: 'Vitalis/01_Brand/manual.pdf',
      filename: 'manual.pdf',
      status: 'ready',
      studied: true,
      updatedAt: new Date('2026-09-02T00:00:00Z'),
    };
    const { controller, notesService } = buildController([], [linha]);

    const result = await controller.scopeStatus({
      clientId: 'cli-1',
      scopePath: 'Vitalis/01_Brand',
    });

    expect(notesService.listScopeStatus).toHaveBeenCalledWith({
      scope: 'client',
      clientId: 'cli-1',
      scopePath: 'Vitalis/01_Brand',
    });
    expect(result).toEqual({ scope: 'client', documents: [linha] });
  });

  it('pasta sem nada ingerido devolve lista vazia', async () => {
    const { controller } = buildController();

    await expect(
      controller.scopeStatus({ clientId: 'cli-1', scopePath: 'Vitalis' }),
    ).resolves.toEqual({ scope: 'client', documents: [] });
  });
});

describe('InternalKnowledgeController.dossier', () => {
  it('devolve o conteúdo do dossiê do cliente', async () => {
    const updatedAt = new Date('2026-09-02T00:00:00Z');
    const { controller, notesService } = buildController([], [], {
      content: { resumo: 'Cliente de saúde.' },
      updatedAt,
    });

    await expect(controller.dossier({ clientId: 'cli-1' })).resolves.toEqual({
      dossier: { resumo: 'Cliente de saúde.' },
      updatedAt,
      state: 'current',
      staleSince: null,
      staleReason: null,
    });
    expect(notesService.findClientNote).toHaveBeenCalledWith('cli-1', 'client_dossier');
  });

  it('cliente sem dossiê devolve nulo, não erro', async () => {
    const { controller } = buildController();

    await expect(controller.dossier({ clientId: 'cli-1' })).resolves.toEqual({
      dossier: null,
      updatedAt: null,
      state: 'absent',
      staleSince: null,
      staleReason: null,
    });
  });

  it('dossiê marcado por remoção não é servido, e o estado diz por quê', async () => {
    const updatedAt = new Date('2026-09-02T00:00:00Z');
    const staleSince = new Date('2026-09-08T09:00:00Z');
    const { controller } = buildController([], [], {
      content: { resumo: 'Cliente de saúde.' },
      updatedAt,
      staleSince,
      staleReason: 'documento removido do acervo: Vitalis/01_Brand/guia.pdf',
    });

    await expect(controller.dossier({ clientId: 'cli-1' })).resolves.toEqual({
      dossier: null,
      updatedAt,
      state: 'stale',
      staleSince,
      staleReason: 'documento removido do acervo: Vitalis/01_Brand/guia.pdf',
    });
  });
});

describe('InternalKnowledgeController.clientOverview', () => {
  const documento = {
    documentId: 'doc-1',
    filename: 'manual-de-marca.pptx',
    scopePath: 'Vitalis/01_Brand',
    storagePath: 'Vitalis/01_Brand/manual-de-marca.pptx',
    mimeType: 'application/octet-stream',
    sizeBytes: '84213',
    sha256: 'a'.repeat(64),
    status: 'ready',
    extractionSource: 'pptx-ocr',
    failureReason: null,
    chunks: 12,
    createdAt: new Date('2026-09-01T10:00:00Z'),
    updatedAt: new Date('2026-09-02T10:00:00Z'),
  };

  it('junta documento, notas e dossiê numa resposta só', async () => {
    const { controller } = buildController([], [], null, {
      clientDocuments: [documento],
      noteDetails: [
        {
          documentId: 'doc-1',
          kind: 'document_summary',
          content: { resumo: 'manual da marca' },
          model: 'llama3.1:8b-instruct-q4_0',
          generatorVersion: 1,
          updatedAt: new Date('2026-09-02T11:00:00Z'),
        },
        {
          documentId: 'doc-1',
          kind: 'brand_guide',
          content: { cores: ['azul-cobalto'] },
          model: 'llama3.1:8b-instruct-q4_0',
          generatorVersion: 1,
          updatedAt: new Date('2026-09-02T11:05:00Z'),
        },
      ],
    });

    const result = await controller.clientOverview({ clientId: 'cli-1' });

    expect(result.clientId).toBe('cli-1');
    expect(result.dossierRegenerating).toBe(false);
    expect(result.documents).toHaveLength(1);
    expect(result.documents[0].filename).toBe('manual-de-marca.pptx');
    expect(result.documents[0].extractionSource).toBe('pptx-ocr');
    expect(result.documents[0].chunks).toBe(12);
    expect(result.documents[0].notes.map((note: any) => note.kind)).toEqual([
      'document_summary',
      'brand_guide',
    ]);
    expect(result.documents[0].notes[0].model).toBe('llama3.1:8b-instruct-q4_0');
  });

  it('expõe o motivo da falha para a tela poder explicar', async () => {
    const { controller } = buildController([], [], null, {
      clientDocuments: [
        {
          ...documento,
          status: 'failed',
          extractionSource: null,
          chunks: 0,
          failureReason: 'Arquivo protegido por senha: .xls cifrado (registro FILEPASS)',
        },
      ],
    });

    const result = await controller.clientOverview({ clientId: 'cli-1' });

    expect(result.documents[0].status).toBe('failed');
    expect(result.documents[0].failureReason).toContain('protegido por senha');
    expect(result.documents[0].notes).toEqual([]);
  });

  it('não devolve embedding em lugar nenhum', async () => {
    const { controller } = buildController([], [], null, { clientDocuments: [documento] });
    const result = await controller.clientOverview({ clientId: 'cli-1' });

    expect(JSON.stringify(result)).not.toContain('embedding');
  });

  it('cliente sem acervo devolve listas vazias, não erro', async () => {
    const { controller } = buildController();
    const result = await controller.clientOverview({ clientId: 'cli-vazio' });

    expect(result.documents).toEqual([]);
    expect(result.dossier).toBeNull();
  });

  it('inclui o dossiê com a procedência dele', async () => {
    const { controller } = buildController([], [], {
      content: { resumo: 'cliente de saúde' },
      model: 'llama3.1:8b-instruct-q4_0',
      generatorVersion: 2,
      updatedAt: new Date('2026-09-03T09:00:00Z'),
    });

    const result = await controller.clientOverview({ clientId: 'cli-1' });

    expect(result.dossier).toEqual({
      content: { resumo: 'cliente de saúde' },
      model: 'llama3.1:8b-instruct-q4_0',
      generatorVersion: 2,
      updatedAt: new Date('2026-09-03T09:00:00Z'),
    });
  });

  it('repassa o limite pedido', async () => {
    const { controller, notesService } = buildController();
    await controller.clientOverview({ clientId: 'cli-1', limit: 50 });

    expect(notesService.listClientDocuments).toHaveBeenCalledWith('cli-1', 50);
  });

  it('informa quando a regeneração do dossiê ainda está na fila', async () => {
    const { controller, knowledgeQueue } = buildController([], [], null, {
      dossierJob: { id: 'dossier-cli-1' },
    });

    const result = await controller.clientOverview({ clientId: 'cli-1' });

    expect(knowledgeQueue.getJob).toHaveBeenCalledWith('dossier-cli-1');
    expect(result.dossierRegenerating).toBe(true);
  });

  it('mantém a tela disponível quando não consegue consultar a fila', async () => {
    const { controller, knowledgeQueue } = buildController();
    knowledgeQueue.getJob.mockRejectedValue(new Error('redis indisponível'));

    const result = await controller.clientOverview({ clientId: 'cli-1' });

    expect(result.dossierRegenerating).toBe(false);
    expect(result.documents).toEqual([]);
  });
});

describe('InternalKnowledgeController.clientOverview — dossiê desatualizado', () => {
  it('não serve o conteúdo do dossiê marcado, mas mantém os documentos', async () => {
    const staleSince = new Date('2026-09-08T09:00:00Z');
    const { controller } = buildController([], [], {
      content: { resumo: 'Cliente de saúde.' },
      model: 'llama3.1',
      generatorVersion: 3,
      updatedAt: new Date('2026-09-02T00:00:00Z'),
      staleSince,
      staleReason: 'documento removido do acervo: Vitalis/01_Brand/guia.pdf',
    }, { clientDocuments: [] });

    const overview = await controller.clientOverview({ clientId: 'cli-1' });

    expect(overview.dossier).toBeNull();
    expect(overview.dossierState).toBe('stale');
    expect(overview.dossierStaleSince).toBe(staleSince);
    expect(overview.dossierStaleReason).toContain('guia.pdf');
    expect(overview.documents).toEqual([]);
  });

  it('cliente sem dossiê aparece como ausente, e não como desatualizado', async () => {
    const { controller } = buildController();

    const overview = await controller.clientOverview({ clientId: 'cli-1' });

    expect(overview.dossierState).toBe('absent');
    expect(overview.dossierStaleSince).toBeNull();
  });
});

describe('InternalKnowledgeController.reprocessDocument', () => {
  const documento = {
    id: 'doc-1',
    clientId: 'cli-1',
    scopePath: 'Vitalis/01_Brand',
    storagePath: 'Vitalis/01_Brand/manual.pdf',
    filename: 'manual.pdf',
    sha256: 'b'.repeat(64),
  };

  it('descarta o job antigo antes de enfileirar, senão o botão não faria nada', async () => {
    const { controller, ingestionQueue, documentsService } = buildController([], [], null, {
      document: documento,
    });

    const result = await controller.reprocessDocument({
      clientId: 'cli-1',
      storagePath: 'Vitalis/01_Brand/manual.pdf',
    });

    const jobId = `ingest-doc-1-${'b'.repeat(64)}`;
    expect(ingestionQueue.remove).toHaveBeenCalledWith(jobId);
    expect(documentsService.markPending).toHaveBeenCalledWith('doc-1');
    expect(ingestionQueue.add).toHaveBeenCalledWith(
      'ingest-document',
      expect.objectContaining({ documentId: 'doc-1', clientId: 'cli-1', sha256: 'b'.repeat(64) }),
      expect.objectContaining({ jobId }),
    );
    expect(result).toEqual({ documentId: 'doc-1', status: 'pending', queued: true });
  });

  it('remove antes de adicionar, nunca o contrário', async () => {
    const ordem: string[] = [];
    const { controller, ingestionQueue } = buildController([], [], null, { document: documento });
    ingestionQueue.remove.mockImplementation(async () => {
      ordem.push('remove');
      return 1;
    });
    ingestionQueue.add.mockImplementation(async () => {
      ordem.push('add');
      return { id: 'job-1' };
    });

    await controller.reprocessDocument({
      clientId: 'cli-1',
      storagePath: 'Vitalis/01_Brand/manual.pdf',
    });

    expect(ordem).toEqual(['remove', 'add']);
  });

  it('job ativo que não pode ser removido não impede o pedido', async () => {
    const { controller, ingestionQueue } = buildController([], [], null, { document: documento });
    ingestionQueue.remove.mockRejectedValue(new Error('job is locked'));

    await expect(
      controller.reprocessDocument({
        clientId: 'cli-1',
        storagePath: 'Vitalis/01_Brand/manual.pdf',
      }),
    ).resolves.toEqual({ documentId: 'doc-1', status: 'pending', queued: true });
  });

  it('recusa documento que não é daquele cliente', async () => {
    const { controller, ingestionQueue } = buildController();

    await expect(
      controller.reprocessDocument({ clientId: 'cli-1', storagePath: 'Outro/arquivo.pdf' }),
    ).rejects.toThrow(/não está no acervo/);
    expect(ingestionQueue.add).not.toHaveBeenCalled();
  });

  it('recusa documento sem sha256 registrado', async () => {
    const { controller, ingestionQueue } = buildController([], [], null, {
      document: { ...documento, sha256: null },
    });

    await expect(
      controller.reprocessDocument({
        clientId: 'cli-1',
        storagePath: 'Vitalis/01_Brand/manual.pdf',
      }),
    ).rejects.toThrow(/sem conteúdo registrado/);
    expect(ingestionQueue.add).not.toHaveBeenCalled();
  });
});

describe('InternalKnowledgeController.regenerateDossier', () => {
  it('descarta o job com atraso e enfileira sem atraso', async () => {
    const { controller, knowledgeQueue } = buildController();

    const result = await controller.regenerateDossier({ clientId: 'cli-1' });

    expect(knowledgeQueue.remove).toHaveBeenCalledWith('dossier-cli-1');
    expect(knowledgeQueue.add).toHaveBeenCalledWith(
      'consolidate-client',
      { clientId: 'cli-1' },
      expect.objectContaining({ jobId: 'dossier-cli-1', delay: 0 }),
    );
    expect(result).toEqual({ clientId: 'cli-1', queued: true });
  });
});
