import { Reflector } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';
import { InternalDocumentsController } from './internal-documents.controller';
import { InternalCapabilityGuard } from '../auth/internal-capability.guard';
import { NORMAN_CAPABILITIES } from '../auth/internal-capabilities';
import type { ConsumerApplication } from '../auth/consumer-registry';

interface Overrides {
  revokedPaths?: string[];
  removedByPath?: number;
  removedByPrefix?: number;
  staleMarked?: number;
  enqueueFails?: boolean;
  registerResult?: { document: { id: string; status: string }; changed: boolean };
  document?: unknown;
  revoked?: boolean;
  revokeFails?: boolean;
}

function buildController(overrides: Overrides = {}) {
  const documentsService = {
    registerClientDocument: vi.fn(async () =>
      overrides.registerResult ?? { document: { id: 'doc-1', status: 'pending' }, changed: true }),
    forgetPath: vi.fn(async () => overrides.removedByPath ?? 1),
    forgetPrefix: vi.fn(async () => overrides.removedByPrefix ?? 2),
    findById: vi.fn(async () => overrides.document ?? null),
  } as any;
  const revocationsService = {
    revokePath: vi.fn(async () => {
      if (overrides.revokeFails) throw new Error('banco indisponível');
      return { removed: overrides.removedByPath ?? 1, tombstones: 1 };
    }),
    revokePrefix: vi.fn(async () => {
      if (overrides.revokeFails) throw new Error('banco indisponível');
      return { removed: overrides.removedByPrefix ?? 2, tombstones: 1 };
    }),
    isRevoked: vi.fn(async (_clientId: string | null, path: string) => (
      overrides.revokedPaths ? overrides.revokedPaths.includes(path) : (overrides.revoked ?? false)
    )),
    lift: vi.fn(async () => 1),
  } as any;
  const knowledgeNotesService = {
    markClientNotesStale: vi.fn(async () => overrides.staleMarked ?? 1),
  } as any;
  const ingestionQueue = { add: vi.fn(async () => ({ id: 'job-1' })) } as any;
  const knowledgeQueue = {
    add: vi.fn(async () => {
      if (overrides.enqueueFails) throw new Error('redis indisponível');
      return { id: 'job-2' };
    }),
  } as any;

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

const FORGET_PATH = { clientId: 'cli-1', storagePath: 'Vitalis/01_Brand/guia.pdf' };
const FORGET_PREFIX = { clientId: 'cli-1', scopePath: 'Vitalis/01_Brand' };

describe('InternalDocumentsController.forgetPath', () => {
  it('invalida o dossiê na mesma chamada em que remove o documento', async () => {
    const { controller, knowledgeNotesService, knowledgeQueue } = buildController();

    await expect(controller.forgetPath(FORGET_PATH)).resolves.toEqual({
      scope: 'client',
      removed: 1,
      revocationState: 'confirmed',
      tombstones: 1,
      invalidated: 1,
      reconsolidationQueued: true,
    });
    expect(knowledgeNotesService.markClientNotesStale).toHaveBeenCalledWith(
      'cli-1',
      'documento removido do acervo: Vitalis/01_Brand/guia.pdf',
    );
    expect(knowledgeQueue.add).toHaveBeenCalled();
  });

  it('fila fora do ar não impede a invalidação, e a resposta diz que o recálculo não foi agendado', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { controller, knowledgeNotesService } = buildController({ enqueueFails: true });

    await expect(controller.forgetPath(FORGET_PATH)).resolves.toEqual({
      scope: 'client',
      removed: 1,
      revocationState: 'confirmed',
      tombstones: 1,
      invalidated: 1,
      reconsolidationQueued: false,
    });
    expect(knowledgeNotesService.markClientNotesStale).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('não invalida nada quando o caminho não estava no acervo', async () => {
    const { controller, knowledgeNotesService, knowledgeQueue } = buildController({ removedByPath: 0 });

    await expect(controller.forgetPath(FORGET_PATH)).resolves.toEqual({
      scope: 'client',
      removed: 0,
      revocationState: 'confirmed',
      tombstones: 1,
      invalidated: 0,
      reconsolidationQueued: false,
    });
    expect(knowledgeNotesService.markClientNotesStale).not.toHaveBeenCalled();
    expect(knowledgeQueue.add).not.toHaveBeenCalled();
  });

  it('dossiê já marcado antes não é marcado de novo, e a remoção segue válida', async () => {
    const { controller } = buildController({ staleMarked: 0 });

    await expect(controller.forgetPath(FORGET_PATH)).resolves.toEqual({
      scope: 'client',
      removed: 1,
      revocationState: 'confirmed',
      tombstones: 1,
      invalidated: 0,
      reconsolidationQueued: true,
    });
  });
});

describe('InternalDocumentsController.forgetPrefix', () => {
  it('invalida o dossiê ao esquecer a pasta inteira', async () => {
    const { controller, knowledgeNotesService } = buildController();

    await expect(controller.forgetPrefix(FORGET_PREFIX)).resolves.toEqual({
      scope: 'client',
      removed: 2,
      revocationState: 'confirmed',
      tombstones: 1,
      invalidated: 1,
      reconsolidationQueued: true,
    });
    expect(knowledgeNotesService.markClientNotesStale).toHaveBeenCalledWith(
      'cli-1',
      'documento removido do acervo: Vitalis/01_Brand',
    );
  });

  it('pasta sem nada no acervo não invalida derivado nenhum', async () => {
    const { controller, knowledgeNotesService } = buildController({ removedByPrefix: 0 });

    await expect(controller.forgetPrefix(FORGET_PREFIX)).resolves.toEqual({
      scope: 'client',
      removed: 0,
      revocationState: 'confirmed',
      tombstones: 1,
      invalidated: 0,
      reconsolidationQueued: false,
    });
    expect(knowledgeNotesService.markClientNotesStale).not.toHaveBeenCalled();
  });
});

describe('InternalDocumentsController.register', () => {
  it('recusa áudio bruto antes de registrar', async () => {
    const { controller, documentsService } = buildController();

    await expect(controller.register({
      clientId: 'cli-1',
      scopePath: 'Vitalis/01_Brand',
      storagePath: 'Vitalis/01_Brand/reuniao.ogg',
      filename: 'reuniao.ogg',
      sha256: 'a'.repeat(64),
      mimeType: 'audio/ogg',
    } as any)).rejects.toThrow();
    expect(documentsService.registerClientDocument).not.toHaveBeenCalled();
  });

  it('conteúdo já ingerido não volta para a fila', async () => {
    const { controller, ingestionQueue } = buildController({
      registerResult: { document: { id: 'doc-1', status: 'ready' }, changed: false },
    });

    await expect(controller.register({
      clientId: 'cli-1',
      scopePath: 'Vitalis/01_Brand',
      storagePath: 'Vitalis/01_Brand/guia.pdf',
      filename: 'guia.pdf',
      sha256: 'a'.repeat(64),
    } as any)).resolves.toEqual({
      documentId: 'doc-1',
      status: 'ready',
      queued: false,
      revoked: false,
    });
    expect(ingestionQueue.add).not.toHaveBeenCalled();
  });

  // O arquivo continua no repositório do Norman depois de revogado. Sem esta
  // guarda, a varredura seguinte o reindexaria e a revogação duraria até a
  // próxima sincronização.
  it('a varredura do repositório não reindexa caminho com lápide', async () => {
    const { controller, documentsService, ingestionQueue } = buildController({ revoked: true });

    await expect(controller.register({
      clientId: 'cli-1',
      scopePath: 'Vitalis/01_Brand',
      storagePath: 'Vitalis/01_Brand/guia.pdf',
      filename: 'guia.pdf',
      sha256: 'a'.repeat(64),
    } as any)).resolves.toEqual({
      documentId: null,
      status: null,
      queued: false,
      revoked: true,
    });
    expect(documentsService.registerClientDocument).not.toHaveBeenCalled();
    expect(ingestionQueue.add).not.toHaveBeenCalled();
  });

  it('o envio administrativo levanta a lápide antes de registrar', async () => {
    const { controller, revocationsService, documentsService } = buildController();

    await controller.register({
      clientId: 'cli-1',
      scopePath: 'Vitalis/01_Brand',
      storagePath: 'Vitalis/01_Brand/guia.pdf',
      filename: 'guia.pdf',
      sha256: 'a'.repeat(64),
      origin: 'administrative',
    } as any);

    expect(revocationsService.lift).toHaveBeenCalledWith(
      'cli-1',
      'Vitalis/01_Brand/guia.pdf',
      'client',
    );
    expect(documentsService.registerClientDocument).toHaveBeenCalled();
  });

  it('a varredura do repositório não levanta lápide nenhuma', async () => {
    const { controller, revocationsService } = buildController();

    await controller.register({
      clientId: 'cli-1',
      scopePath: 'Vitalis/01_Brand',
      storagePath: 'Vitalis/01_Brand/guia.pdf',
      filename: 'guia.pdf',
      sha256: 'a'.repeat(64),
    } as any);

    expect(revocationsService.lift).not.toHaveBeenCalled();
  });
});

describe('InternalDocumentsController.forgetPath sob falha', () => {
  // Sem exceção, o Norman marcaria a fonte como revogada com base no silêncio,
  // e os trechos antigos continuariam pesquisáveis.
  it('falha ao gravar a lápide não vira revogação confirmada', async () => {
    const { controller, knowledgeNotesService } = buildController({ revokeFails: true });

    await expect(controller.forgetPath(FORGET_PATH)).rejects.toThrow('banco indisponível');
    expect(knowledgeNotesService.markClientNotesStale).not.toHaveBeenCalled();
  });
});

describe('InternalDocumentsController.status', () => {
  const NORMAN = {
    name: 'norman',
    token: 't',
    features: [],
    scopes: ['client' as const],
    capabilities: NORMAN_CAPABILITIES,
  };

  function documento(knowledgeScope: string, clientId: string | null) {
    return {
      id: 'doc-1',
      status: 'ready',
      knowledgeScope,
      clientId,
      scopePath: 'Vitalis/01_Brand',
      sha256: 'a'.repeat(64),
      updatedAt: new Date('2026-09-09T00:00:00Z'),
    };
  }

  it('documento inexistente responde ausência sem conferir nível', async () => {
    const { controller } = buildController({ document: null });

    await expect(controller.status('doc-1', { consumer: leitorDeCliente() }))
      .resolves.toEqual({ documentId: 'doc-1', status: null });
  });

  it('quem só lê acervo de cliente não lê documento do acervo geral', async () => {
    const { controller } = buildController({ document: documento('system', null) });

    await expect(controller.status('doc-1', { consumer: leitorDeCliente() }))
      .rejects.toThrow('não recebeu knowledge.system.read');
  });

  it('quem só lê o acervo geral não lê documento de cliente', async () => {
    const { controller } = buildController({ document: documento('client', 'cli-1') });

    await expect(controller.status('doc-1', { consumer: leitorDeSistema() }))
      .rejects.toThrow('não recebeu knowledge.client.read');
  });

  it('o Norman lê os dois níveis', async () => {
    const geral = buildController({ document: documento('system', null) });
    await expect(geral.controller.status('doc-1', { consumer: NORMAN }))
      .resolves.toMatchObject({ scope: 'system', clientId: null });

    const cliente = buildController({ document: documento('client', 'cli-1') });
    await expect(cliente.controller.status('doc-1', { consumer: NORMAN }))
      .resolves.toMatchObject({ scope: 'client', clientId: 'cli-1' });
  });

  function leitorDeCliente() {
    return {
      name: 'niprofe',
      token: 't',
      features: ['chat'],
      scopes: ['person' as const],
      capabilities: ['knowledge.client.read' as const],
    };
  }

  function leitorDeSistema() {
    return {
      name: 'niprofe',
      token: 't',
      features: ['chat'],
      scopes: ['person' as const],
      capabilities: ['knowledge.system.read' as const],
    };
  }
});

describe('InternalDocumentsController.revocationState', () => {
  it('diz quais caminhos ainda estão cobertos por uma lápide, sem tocar no acervo', async () => {
    const { controller, documentsService, ingestionQueue } = buildController({
      revokedPaths: ['Vitalis/01_Brand/guia.pdf'],
    });

    const resposta = await controller.revocationState({
      clientId: 'cli-1',
      paths: ['Vitalis/01_Brand/guia.pdf', 'Vitalis/01_Brand/manual.pdf'],
    } as never);

    expect(resposta).toEqual({ scope: 'client', revoked: ['Vitalis/01_Brand/guia.pdf'] });
    expect(documentsService.registerClientDocument).not.toHaveBeenCalled();
    expect(ingestionQueue.add).not.toHaveBeenCalled();
  });

  it('o acervo geral consulta sem cliente e no próprio nível', async () => {
    const { controller, revocationsService } = buildController({ revokedPaths: [] });

    const resposta = await controller.revocationState({
      scope: 'system',
      paths: ['_Conhecimento geral do sistema/tom.pdf'],
    } as never);

    expect(resposta).toEqual({ scope: 'system', revoked: [] });
    expect(revocationsService.isRevoked).toHaveBeenCalledWith(
      null,
      '_Conhecimento geral do sistema/tom.pdf',
      'system',
    );
  });

  it('a lápide de uma pasta acima também bloqueia o caminho', async () => {
    const { controller } = buildController({ revoked: true });

    const resposta = await controller.revocationState({
      scope: 'system',
      paths: ['_Conhecimento geral do sistema/tom.pdf'],
    } as never);

    expect(resposta.revoked).toEqual(['_Conhecimento geral do sistema/tom.pdf']);
  });
});

describe('autorização da consulta de lápides', () => {
  function decide(consumer: ConsumerApplication, body: unknown) {
    return new InternalCapabilityGuard(new Reflector()).canActivate({
      getHandler: () => InternalDocumentsController.prototype.revocationState,
      getClass: () => InternalDocumentsController,
      switchToHttp: () => ({ getRequest: () => ({ consumer, body }) }),
    } as never);
  }

  const norman: ConsumerApplication = {
    name: 'norman',
    token: 't',
    features: [],
    scopes: ['client'],
    capabilities: NORMAN_CAPABILITIES,
  };
  const restrito: ConsumerApplication = {
    name: 'niprofe',
    token: 'u',
    features: [],
    scopes: ['person'],
    capabilities: ['documents.extract'],
  };

  it('o token do Norman consulta os dois níveis', () => {
    expect(decide(norman, { clientId: 'cli-1', paths: [] })).toBe(true);
    expect(decide(norman, { scope: 'system', paths: [] })).toBe(true);
  });

  it('outro consumidor sem a capacidade de leitura é recusado', () => {
    expect(() => decide(restrito, { clientId: 'cli-1', paths: [] }))
      .toThrow('não recebeu knowledge.client.read');
    expect(() => decide(restrito, { scope: 'system', paths: [] }))
      .toThrow('não recebeu knowledge.system.read');
  });

  it('a leitura de cliente não abre a leitura do acervo geral', () => {
    const soCliente: ConsumerApplication = { ...restrito, capabilities: ['knowledge.client.read'] };

    expect(decide(soCliente, { clientId: 'cli-1', paths: [] })).toBe(true);
    expect(() => decide(soCliente, { scope: 'system', paths: [] }))
      .toThrow('não recebeu knowledge.system.read');
  });
});
