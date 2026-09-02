import { describe, expect, it, vi } from 'vitest';
import { InternalKnowledgeController } from './internal-knowledge.controller';

function buildController(
  snippets: Array<{ content: string }> = [],
  scopeStatus: unknown[] = [],
) {
  const chunksService = { searchSimilar: vi.fn(async () => snippets) } as any;
  const ollamaService = { embed: vi.fn(async () => [0.1, 0.2, 0.3]) } as any;
  const notesService = { listScopeStatus: vi.fn(async () => scopeStatus) } as any;
  return {
    controller: new InternalKnowledgeController(chunksService, ollamaService, notesService),
    chunksService,
    ollamaService,
    notesService,
  };
}

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
      scope: { kind: 'client', clientId: 'cli-1', scopePath: 'Vitalis/01_Brand' },
      embedding: [0.1, 0.2, 0.3],
    });
    expect(result).toEqual({ snippets: [{ content: 'tom direto' }] });
  });

  // O escopo de pessoa é o do chat de hoje e recupera de outra família de linhas;
  // esta rota nunca pode cair nele.
  it('nunca busca no escopo de pessoa', async () => {
    const { controller, chunksService } = buildController();

    await controller.search({ clientId: 'cli-1', scopePath: 'Vitalis', question: 'oi' });

    expect(chunksService.searchSimilar.mock.calls[0][0].scope.kind).toBe('client');
  });

  it('devolve lista vazia quando não há o que recuperar', async () => {
    const { controller } = buildController();

    await expect(controller.search({ clientId: 'cli-1', scopePath: 'Vitalis', question: 'oi' }))
      .resolves.toEqual({ snippets: [] });
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
      clientId: 'cli-1',
      scopePath: 'Vitalis/01_Brand',
    });
    expect(result).toEqual({ documents: [linha] });
  });

  it('pasta sem nada ingerido devolve lista vazia', async () => {
    const { controller } = buildController();

    await expect(
      controller.scopeStatus({ clientId: 'cli-1', scopePath: 'Vitalis' }),
    ).resolves.toEqual({ documents: [] });
  });
});
