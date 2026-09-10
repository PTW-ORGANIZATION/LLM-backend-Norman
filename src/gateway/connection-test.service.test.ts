import { describe, expect, it, vi } from 'vitest';
import { ConnectionTestService } from './connection-test.service';
import { ProviderFailure } from './llm-provider.port';
import { resolveConnection } from './provider-connection';

const AMBIENTE = {
  OLLAMA_MODEL: 'llama-local',
  OLLAMA_ALLOWED_MODELS: 'llama-local,llama-grande',
  OPENAI_ALLOWED_MODELS: '',
  GROK_API_KEY: '',
};

/**
 * O registro de revisões em memória, com o mesmo contrato do de verdade.
 *
 * A suíte precisa dele porque o teste passou a resolver `connectionKey +
 * revision` antes de tocar no provedor: sem revisão reconhecida, nenhuma
 * conexão é testável, que é justamente o comportamento em prova.
 */
function buildRevisions(records: Array<{ connectionKey: string; revision: number; model: string }>) {
  return {
    require: vi.fn(async (input: { connectionKey: string; revision: number; model?: string }) => {
      const record = records.find(
        (item) => item.connectionKey === input.connectionKey && item.revision === input.revision,
      );
      if (!record) {
        throw new Error(
          `a revisão ${input.revision} da conexão "${input.connectionKey}" não é reconhecida por este backend`,
        );
      }
      const connection = resolveConnection(input.connectionKey);
      if (!connection.available) throw new Error(connection.reason);
      if (input.model && input.model !== record.model) {
        throw new Error(
          `a revisão ${input.revision} de "${input.connectionKey}" foi reconhecida com o modelo "${record.model}"`,
        );
      }
      if (!connection.allowedModels.includes(record.model)) {
        throw new Error(`o modelo "${record.model}" não está entre os permitidos desta conexão`);
      }
      return { record: { ...record, isEnabled: true, activationId: null }, connection };
    }),
  } as any;
}

function buildService(
  generate: any = vi.fn(async () => ({ text: 'ok', promptTokens: 1, completionTokens: 1 })),
  records: Array<{ connectionKey: string; revision: number; model: string }> = [
    { connectionKey: 'ollama', revision: 3, model: 'llama-local' },
    { connectionKey: 'ollama', revision: 4, model: 'llama-grande' },
    { connectionKey: 'ollama', revision: 5, model: 'modelo-proibido' },
    { connectionKey: 'grok', revision: 1, model: 'grok-x' },
  ],
) {
  const config = { get: (_key: string, fallback?: unknown) => fallback } as any;
  const provider = { protocol: 'openai_chat', capabilities: () => ({}), generate } as any;
  return {
    service: new ConnectionTestService(config, provider, buildRevisions(records)),
    generate: generate as any,
  };
}

describe('ConnectionTestService', () => {
  const original = { ...process.env };

  function comAmbiente<T>(patch: Record<string, string>, task: () => T): T {
    Object.assign(process.env, AMBIENTE, patch);
    try {
      return task();
    } finally {
      for (const key of Object.keys({ ...AMBIENTE, ...patch })) {
        if (original[key] === undefined) delete process.env[key];
        else process.env[key] = original[key];
      }
    }
  }

  it('conexão provisionada e alcançável passa, com a latência medida', async () => {
    const { service, generate } = buildService();

    const resultado = await comAmbiente({}, () =>
      service.test({ connectionKey: 'ollama', revision: 3 }));

    expect(resultado).toMatchObject({
      connectionKey: 'ollama',
      revision: 3,
      status: 'passed',
      model: 'llama-local',
    });
    expect(resultado.latencyMs).toBeGreaterThanOrEqual(0);
    expect(generate).toHaveBeenCalled();
  });

  // Configuração ausente é um terceiro estado: não é falha do provedor nem
  // aprovação, e a tela precisa dizer qual variável falta provisionar.
  it('conexão sem provisionamento devolve estado próprio, não falha de teste', async () => {
    const { service, generate } = buildService();

    const resultado = await comAmbiente({}, () =>
      service.test({ connectionKey: 'grok', revision: 1 }));

    expect(resultado.status).toBe('unconfigured');
    expect(resultado.message).toContain('GROK_API_KEY');
    expect(generate).not.toHaveBeenCalled();
  });

  // A revisão é resolvida antes do provedor: sem esta trava, o teste aprovava
  // "a conexão" e a aprovação valia para uma revisão que ninguém registrou.
  it('revisão não reconhecida não é testada', async () => {
    const { service, generate } = buildService();

    const resultado = await comAmbiente({}, () =>
      service.test({ connectionKey: 'ollama', revision: 99 }));

    expect(resultado).toMatchObject({ status: 'unconfigured', revision: 99 });
    expect(resultado.message).toContain('não é reconhecida');
    expect(generate).not.toHaveBeenCalled();
  });

  it('o teste aprova exatamente o modelo registrado na revisão', async () => {
    const { service, generate } = buildService();

    const resultado = await comAmbiente({}, () =>
      service.test({ connectionKey: 'ollama', revision: 4 }));

    expect(resultado).toMatchObject({ status: 'passed', model: 'llama-grande' });
    expect(generate.mock.calls[0][1]).toMatchObject({ model: 'llama-grande' });
  });

  it('modelo divergente do registrado na revisão é recusado', async () => {
    const { service, generate } = buildService();

    const resultado = await comAmbiente({}, () =>
      service.test({ connectionKey: 'ollama', revision: 3, model: 'llama-grande' }));

    expect(resultado.status).toBe('unconfigured');
    expect(generate).not.toHaveBeenCalled();
  });

  it('modelo fora da allowlist não é testado', async () => {
    const { service, generate } = buildService();

    const resultado = await comAmbiente({}, () =>
      service.test({ connectionKey: 'ollama', revision: 5 }));

    expect(resultado.status).toBe('unconfigured');
    expect(resultado.message).toContain('não está entre os permitidos');
    expect(generate).not.toHaveBeenCalled();
  });

  // A mensagem do provedor às vezes ecoa o cabeçalho enviado, e ela iria parar
  // na tela administrativa e no banco do Norman.
  it('credencial recusada não devolve o corpo do provedor', async () => {
    const generate = vi.fn(async () => {
      throw new ProviderFailure('authorization', 'Bearer xai-chave-secreta rejeitado pela api');
    });
    const { service } = buildService(generate);

    const resultado = await comAmbiente({}, () => service.test({ connectionKey: 'ollama', revision: 3 }));

    expect(resultado.status).toBe('failed');
    expect(resultado.message).toBe('a credencial provisionada foi recusada pelo provedor');
    expect(resultado.message).not.toContain('xai-');
  });

  it('cada tipo de falha vira um motivo estável', async () => {
    for (const [kind, esperado] of [
      ['timeout', 'não respondeu dentro do tempo'],
      ['rate_limited', 'limite de uso'],
      ['unavailable', 'não foi possível alcançar'],
    ] as const) {
      const { service } = buildService(vi.fn(async () => {
        throw new ProviderFailure(kind as any, 'detalhe cru do provedor');
      }));

      const resultado = await comAmbiente({}, () => service.test({ connectionKey: 'ollama', revision: 3 }));

      expect(resultado.status).toBe('failed');
      expect(resultado.message).toContain(esperado);
      expect(resultado.message).not.toContain('detalhe cru');
    }
  });

  it('falha não classificada não vaza a mensagem original', async () => {
    const { service } = buildService(vi.fn(async () => { throw new Error('ECONNREFUSED 10.0.0.1:11434'); }));

    const resultado = await comAmbiente({}, () => service.test({ connectionKey: 'ollama', revision: 3 }));

    expect(resultado.status).toBe('failed');
    expect(resultado.message).not.toContain('10.0.0.1');
  });
});
