import { Reflector } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';
import { InternalGenerationController } from './internal-generation.controller';
import { OpenAiChatAdapter } from './openai-chat.adapter';
import { GENERATION_CONTRACT_VERSION } from './generation.dto';
import { InternalCapabilityGuard } from '../auth/internal-capability.guard';
import { NORMAN_CAPABILITIES } from '../auth/internal-capabilities';
import type { ConsumerApplication } from '../auth/consumer-registry';

function autoriza(handler: Function, consumer: ConsumerApplication, body: unknown = {}) {
  const guard = new InternalCapabilityGuard(new Reflector());
  return guard.canActivate({
    getHandler: () => handler,
    getClass: () => InternalGenerationController,
    switchToHttp: () => ({ getRequest: () => ({ consumer, body }) }),
  } as any);
}

function buildController(
  testResult: Record<string, unknown> = { status: 'passed' },
  streamEvents: unknown[] = [
    { type: 'delta', text: 'azul' },
    { type: 'completed', correlationId: 'corr-1', usedConnectionKey: 'ollama' },
  ],
) {
  const generationService = {
    generate: vi.fn(async () => ({ text: 'ok' })),
    generateStream: vi.fn(async function* (_dto: unknown, signal?: AbortSignal) {
      for (const evento of streamEvents) {
        if (signal?.aborted) return;
        yield evento;
      }
    }),
  } as any;
  const connectionTestService = { test: vi.fn(async () => testResult) } as any;
  const connectionRevisions = {
    describe: vi.fn(async () => []),
    sync: vi.fn(async (input: unknown) => input),
    confirmActivation: vi.fn(async (input: unknown) => input),
    findActivation: vi.fn(async () => null),
  } as any;
  return {
    controller: new InternalGenerationController(
      generationService,
      connectionTestService,
      connectionRevisions,
      new OpenAiChatAdapter(),
    ),
    generationService,
    connectionTestService,
    connectionRevisions,
  };
}

describe('InternalGenerationController.capabilities', () => {
  it('declara a versão do contrato, as operações e as capacidades do provedor', async () => {
    const { controller } = buildController();

    const capabilities = await controller.capabilities();

    expect(capabilities.contractVersion).toBe(GENERATION_CONTRACT_VERSION);
    expect(capabilities.features.map((feature) => feature.feature)).toContain('chat');
    expect(capabilities.provider).toMatchObject({ streaming: true, structuredOutput: true });
    expect(capabilities.streamContractVersion).toBe(1);
    expect(capabilities.fallbackEligibleCauses).toContain('unavailable');
    expect(capabilities.fallbackEligibleCauses).not.toContain('authorization');
  });

  it('operação genérica é declarada como tal, para o Norman não mandar cliente nela', async () => {
    const { controller } = buildController();

    const insights = (await controller.capabilities()).features.find((f) => f.feature === 'job_insights');

    expect(insights).toMatchObject({ usesClientKnowledge: false });
  });

  it('conexão sem configuração aparece indisponível com a variável que falta', async () => {
    const original = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const { controller } = buildController();

      const openai = (await controller.capabilities()).connections.find((c) => c.key === 'openai');

      expect(openai).toMatchObject({ available: false, reason: 'defina OPENAI_API_KEY' });
      expect(openai).not.toHaveProperty('defaultModel');
    } finally {
      if (original === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = original;
    }
  });

  it('nenhuma conexão declarada expõe URL ou segredo', async () => {
    const original = { key: process.env.GROK_API_KEY, model: process.env.GROK_MODEL };
    process.env.GROK_API_KEY = 'segredo-do-grok';
    process.env.GROK_MODEL = 'grok-x';
    try {
      const { controller } = buildController();

      const declarado = JSON.stringify((await controller.capabilities()).connections);

      expect(declarado).not.toContain('segredo-do-grok');
      expect(declarado).not.toContain('api.x.ai');
    } finally {
      if (original.key === undefined) delete process.env.GROK_API_KEY;
      else process.env.GROK_API_KEY = original.key;
      if (original.model === undefined) delete process.env.GROK_MODEL;
      else process.env.GROK_MODEL = original.model;
    }
  });
});

describe('InternalGenerationController.complete', () => {
  it('entrega o pedido ao serviço de geração sem reinterpretá-lo', async () => {
    const { controller, generationService } = buildController();
    const dto = { contractVersion: GENERATION_CONTRACT_VERSION, feature: 'chat' } as any;

    await expect(controller.complete(dto)).resolves.toEqual({ text: 'ok' });
    expect(generationService.generate).toHaveBeenCalledWith(dto);
  });
});

describe('reutilização por outra aplicação', () => {
  const NIPROFE = {
    name: 'niprofe',
    token: 'segredo-niprofe',
    features: ['chat'],
    scopes: ['person' as const],
    capabilities: [],
  };

  it('as capacidades declaradas são as da aplicação que chamou', async () => {
    const { controller } = buildController();

    const capabilities = await controller.capabilities({ consumer: NIPROFE });

    expect(capabilities.application).toBe('niprofe');
    expect(capabilities.allowedScopes).toEqual(['person']);
    expect(capabilities.features.map((feature) => feature.feature)).toEqual(['chat']);
  });

  it('sem aplicação identificada, as capacidades são as do Norman', async () => {
    const { controller } = buildController();

    const capabilities = await controller.capabilities();

    expect(capabilities.application).toBe('norman');
    expect(capabilities.allowedScopes).toEqual(['client']);
    expect(capabilities.features.length).toBeGreaterThan(1);
  });

  it('declara explicitamente o que existe de multimodal, e o que não existe', async () => {
    const { controller } = buildController();

    expect((await controller.capabilities()).multimodal).toEqual({
      imageDescription: { implemented: true, exposedToConsumers: false, usedBy: ['ocr-de-ingestao'] },
      imageGeneration: { implemented: false, exposedToConsumers: false, usedBy: [] },
      spellCheckOnArtwork: { implemented: false, exposedToConsumers: false, usedBy: [] },
    });
  });

  it('operação fora das da aplicação é recusada antes de gerar', () => {
    const { controller, generationService } = buildController();

    expect(() => controller.complete(
      { feature: 'briefing_final' } as any,
      { consumer: NIPROFE },
    )).toThrow(/não pode pedir a operação "briefing_final"/);
    expect(generationService.generate).not.toHaveBeenCalled();
  });

  it('aplicação sem escopo de cliente não alcança conhecimento de cliente', () => {
    const { controller, generationService } = buildController();

    expect(() => controller.complete(
      { feature: 'chat', clientId: 'cli-1' } as any,
      { consumer: NIPROFE },
    )).toThrow(/não alcança conhecimento por cliente/);
    expect(generationService.generate).not.toHaveBeenCalled();
  });

  it('a operação permitida da aplicação passa, no escopo dela', async () => {
    const { controller, generationService } = buildController();

    await expect(controller.complete({ feature: 'chat' } as any, { consumer: NIPROFE }))
      .resolves.toEqual({ text: 'ok' });
    expect(generationService.generate).toHaveBeenCalled();
  });

  it('o Norman continua alcançando conhecimento por cliente', async () => {
    const { controller, generationService } = buildController();

    await controller.complete({ feature: 'chat', clientId: 'cli-1' } as any, {
      consumer: {
        name: 'norman',
        token: 'x',
        features: [],
        scopes: ['client'],
        capabilities: NORMAN_CAPABILITIES,
      },
    });

    expect(generationService.generate).toHaveBeenCalled();
  });
});

describe('InternalGenerationController — ativação', () => {
  it('a confirmação vai para o registro com a tupla exata', async () => {
    const { controller, connectionRevisions } = buildController();

    await controller.confirmActivation({
      connectionKey: 'ollama',
      revision: 3,
      activationId: 'act-1',
    } as any);

    expect(connectionRevisions.confirmActivation).toHaveBeenCalledWith({
      connectionKey: 'ollama',
      revision: 3,
      activationId: 'act-1',
    });
  });

  it('consumidor sem a capacidade de conexão não passa do guard para confirmar ativação', () => {
    const { connectionRevisions } = buildController();

    expect(() => autoriza(
      InternalGenerationController.prototype.confirmActivation,
      { name: 'niprofe', token: 't', features: ['chat'], scopes: ['person'], capabilities: [] },
    )).toThrow('não recebeu connections.administer');
    expect(connectionRevisions.confirmActivation).not.toHaveBeenCalled();
  });

  /**
   * A leitura de reconciliação. Um timeout não diz se a confirmação aconteceu, e
   * presumir que não aconteceu deixaria os dois lados divergentes: 404 aqui é
   * ausência de confirmação, e não incerteza.
   */
  it('identidade sem confirmação responde 404, e não um vínculo inventado', async () => {
    const { controller } = buildController();

    await expect(controller.describeActivation('act-que-nunca-existiu'))
      .rejects.toThrow(/não está confirmada neste backend/);
  });

  it('identidade confirmada é devolvida com chave, revisão e modelo', async () => {
    const { controller, connectionRevisions } = buildController();
    connectionRevisions.findActivation = vi.fn(async () => ({
      activationId: 'act-1',
      connectionKey: 'ollama',
      revision: 3,
      model: 'llama-local',
      confirmedAt: new Date('2026-09-08T00:00:00Z'),
    }));

    await expect(controller.describeActivation('act-1')).resolves.toMatchObject({
      activationId: 'act-1',
      connectionKey: 'ollama',
      revision: 3,
      model: 'llama-local',
    });
  });

  it('consumidor sem a capacidade de conexão não passa do guard para consultar ativação', () => {
    const { connectionRevisions } = buildController();

    expect(() => autoriza(
      InternalGenerationController.prototype.describeActivation,
      { name: 'niprofe', token: 't', features: ['chat'], scopes: ['person'], capabilities: [] },
    )).toThrow('não recebeu connections.administer');
    expect(connectionRevisions.findActivation).not.toHaveBeenCalled();
  });

  it('as revisões declaradas trazem as identidades confirmadas', async () => {
    const { controller, connectionRevisions } = buildController();
    connectionRevisions.describe = vi.fn(async (key: string) => (key === 'ollama'
      ? [{
          connectionKey: 'ollama',
          revision: 3,
          model: 'llama-local',
          configDigest: 'digest',
          isEnabled: true,
          createdAt: new Date(),
          activationIds: ['act-1'],
        }]
      : []));

    const ollama = (await controller.capabilities()).connections.find((c) => c.key === 'ollama');

    expect(ollama?.recognizedRevisions).toEqual([
      { revision: 3, model: 'llama-local', isEnabled: true, isActivated: true, activationIds: ['act-1'] },
    ]);
  });

  it('revisão sem identidade confirmada não aparece como ativada', async () => {
    const { controller, connectionRevisions } = buildController();
    connectionRevisions.describe = vi.fn(async (key: string) => (key === 'ollama'
      ? [{
          connectionKey: 'ollama',
          revision: 4,
          model: 'llama-grande',
          configDigest: 'digest',
          isEnabled: true,
          createdAt: new Date(),
          activationIds: [],
        }]
      : []));

    const ollama = (await controller.capabilities()).connections.find((c) => c.key === 'ollama');

    expect(ollama?.recognizedRevisions).toEqual([
      { revision: 4, model: 'llama-grande', isEnabled: true, isActivated: false, activationIds: [] },
    ]);
  });
});

describe('InternalGenerationController.testConnection', () => {
  // Testar do lado do Norman provava outra coisa: outra rede, outra
  // biblioteca, outro conjunto de variáveis.
  it('o teste é executado por quem faz a geração real', async () => {
    const { controller, connectionTestService } = buildController();

    await expect(controller.testConnection({ connectionKey: 'ollama', revision: 3 } as any))
      .resolves.toMatchObject({ status: 'passed' });
    expect(connectionTestService.test).toHaveBeenCalledWith({
      connectionKey: 'ollama',
      revision: 3,
    });
  });

  it('consumidor sem a capacidade de conexão não passa do guard para testar conexão', () => {
    const { connectionTestService } = buildController();

    expect(() => autoriza(
      InternalGenerationController.prototype.testConnection,
      { name: 'niprofe', token: 't', features: ['chat'], scopes: ['person'], capabilities: [] },
    )).toThrow('não recebeu connections.administer');
    expect(connectionTestService.test).not.toHaveBeenCalled();
  });

  it('o Norman administra conexão porque recebeu a capacidade', () => {
    buildController();

    expect(autoriza(
      InternalGenerationController.prototype.testConnection,
      { name: 'norman', token: 't', features: [], scopes: ['client'], capabilities: NORMAN_CAPABILITIES },
    )).toBe(true);
  });
});

function fakeResponse() {
  const escritas: string[] = [];
  const ouvintes = new Map<string, () => void>();
  return {
    escritas,
    dispara: (evento: string) => ouvintes.get(evento)?.(),
    response: {
      setHeader: vi.fn(),
      flushHeaders: vi.fn(),
      write: vi.fn((linha: string) => { escritas.push(linha); return true; }),
      end: vi.fn(),
      on: vi.fn((evento: string, ouvinte: () => void) => { ouvintes.set(evento, ouvinte); }),
    } as any,
  };
}

function eventosDe(escritas: string[]) {
  return escritas
    .filter((linha) => linha.startsWith('data: '))
    .map((linha) => JSON.parse(linha.slice(6).trim()));
}

describe('InternalGenerationController.stream', () => {
  const dto = { correlationId: 'corr-1', feature: 'chat' } as any;

  it('abre declarando a versão do contrato de fluxo', async () => {
    const { controller } = buildController();
    const { response, escritas } = fakeResponse();

    await controller.stream(dto, response);

    expect(eventosDe(escritas)[0]).toEqual({ type: 'open', contractVersion: 1 });
  });

  it('cada evento do gateway vira uma linha do fluxo', async () => {
    const { controller } = buildController();
    const { response, escritas } = fakeResponse();

    await controller.stream(dto, response);

    const eventos = eventosDe(escritas);
    expect(eventos.map((evento) => evento.type)).toEqual(['open', 'delta', 'completed']);
    expect(response.end).toHaveBeenCalled();
  });

  // Sem isso, o navegador ia embora e a geração seguia sendo cobrada e
  // ocupando a GPU até terminar sozinha.
  it('o fechamento da conexão cancela a geração', async () => {
    const { controller, generationService } = buildController();
    const { response } = fakeResponse();

    const emCurso = controller.stream(dto, response);
    response.on.mock.calls.find(([evento]: [string]) => evento === 'close')?.[1]?.();
    await emCurso;

    expect(generationService.generateStream.mock.calls[0][1]).toBeInstanceOf(AbortSignal);
  });

  it('falha antes de abrir o fluxo vira evento de falha, e não conexão pendurada', async () => {
    const { controller, generationService } = buildController();
    generationService.generateStream = vi.fn(async function* () {
      throw new Error('escopo de acervo foi informado sem cliente');
      yield undefined;
    });
    const { response, escritas } = fakeResponse();

    await controller.stream(dto, response);

    const eventos = eventosDe(escritas);
    expect(eventos[eventos.length - 1]).toMatchObject({ type: 'failed', streamed: false });
    expect(response.end).toHaveBeenCalled();
  });

  it('consumidor sem a operação não abre fluxo nenhum', async () => {
    const { controller, generationService } = buildController();
    const { response } = fakeResponse();

    await expect(controller.stream(
      dto,
      response,
      { consumer: { name: 'niprofe', token: 't', features: ['job_insights'], scopes: ['person'] } } as any,
    )).rejects.toThrow('não pode pedir a operação');
    expect(generationService.generateStream).not.toHaveBeenCalled();
  });
});
