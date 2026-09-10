import { afterEach, describe, expect, it, vi } from 'vitest';
import { HealthController } from './health.controller';
import { RETENTION_ENV } from '../config/retention-policy';
import { GENERATION_CONTRACT_VERSION } from '../gateway/generation.dto';

const ORIGINAL = Object.fromEntries(
  Object.values(RETENTION_ENV).map((env) => [env, process.env[env]]),
);

const AMBIENTE_COM_CONEXAO = { OLLAMA_MODEL: 'llama-local' };

function buildController(
  query: () => Promise<unknown>,
  ping: () => Promise<string> = async () => 'PONG',
) {
  Object.assign(process.env, AMBIENTE_COM_CONEXAO);
  return new HealthController({ query } as never, { client: Promise.resolve({ ping }) } as never);
}

afterEach(() => {
  for (const [env, valor] of Object.entries(ORIGINAL)) {
    if (valor === undefined) delete process.env[env];
    else process.env[env] = valor;
  }
});

describe('HealthController', () => {
  it('banco respondendo é serviço ok', async () => {
    const controller = buildController(vi.fn(async () => [{ '?column?': 1 }]));

    const resultado = await controller.check();

    expect(resultado.status).toBe('ok');
    expect(resultado.dependencies.database).toEqual({ ok: true });
    expect(resultado.uptimeSeconds).toBeGreaterThanOrEqual(0);
  });

  it('banco fora deixa o serviço degradado, sem detalhe do driver na resposta', async () => {
    const controller = buildController(vi.fn(async () => {
      throw new Error('password authentication failed for user "norman"');
    }));

    const resultado = await controller.check();

    expect(resultado.status).toBe('degraded');
    expect(resultado.dependencies.database).toEqual({ ok: false });
    expect(JSON.stringify(resultado)).not.toContain('password');
  });

  it('retenção sem decisão aparece como pendência, e não como prazo infinito', async () => {
    for (const env of Object.values(RETENTION_ENV)) delete process.env[env];
    const controller = buildController(vi.fn(async () => []));

    const resultado = await controller.check();

    expect(resultado.retention.configured).toEqual([]);
    expect(resultado.retention.pendingDecision).toEqual([
      'temporaryAudio',
      'transcript',
      'conversation',
      'generationAudit',
    ]);
  });

  it('a resposta diz o que já foi decidido, sem expor o prazo', async () => {
    for (const env of Object.values(RETENTION_ENV)) delete process.env[env];
    process.env[RETENTION_ENV.temporaryAudio] = '7';
    const controller = buildController(vi.fn(async () => []));

    const resultado = await controller.check();

    expect(resultado.retention.configured).toEqual(['temporaryAudio']);
    expect(JSON.stringify(resultado.retention)).not.toContain('7');
  });
});

describe('HealthController — camadas', () => {
  // Cada camada quebra sozinha e exige uma ação diferente: nenhuma delas se
  // resolve reiniciando o que estiver saudável.
  it('a fila fora derruba o serviço sem derrubar o banco', async () => {
    const controller = buildController(
      vi.fn(async () => [{ ok: 1 }]),
      vi.fn(async () => { throw new Error('redis fora'); }),
    );

    const resultado = await controller.check();

    expect(resultado.status).toBe('degraded');
    expect(resultado.dependencies.database).toEqual({ ok: true });
    expect(resultado.dependencies.queue).toEqual({ ok: false });
  });

  it('conexão sem provisionamento aparece como tal, sem derrubar o gateway', async () => {
    const controller = buildController(vi.fn(async () => [{ ok: 1 }]));

    const resultado = await controller.check();

    // Ollama tem padrão local e está sempre provisionada; as que exigem
    // credencial aparecem como pendentes até alguém provisioná-las.
    expect(resultado.gateway.connections).toEqual(
      expect.arrayContaining([
        { key: 'ollama', provisioned: true },
        { key: 'openai', provisioned: false },
        { key: 'grok', provisioned: false },
      ]),
    );
    expect(resultado.dependencies.gateway).toEqual({ ok: true });
  });

  it('declara as versões de contrato e quais conexões estão provisionadas', async () => {
    const controller = buildController(vi.fn(async () => [{ ok: 1 }]));

    const resultado = await controller.check();

    expect(resultado.gateway.contractVersion).toBe(GENERATION_CONTRACT_VERSION);
    expect(resultado.gateway.streamContractVersion).toBe(1);
    expect(resultado.gateway.connections).toEqual(
      expect.arrayContaining([{ key: 'ollama', provisioned: true }]),
    );
  });

  // A rota é aberta: nem URL, nem modelo, nem o nome da variável que falta.
  it('a saúde não expõe configuração de provedor', async () => {
    const controller = buildController(vi.fn(async () => [{ ok: 1 }]));

    const serializada = JSON.stringify(await controller.check());

    expect(serializada).not.toContain('OLLAMA');
    expect(serializada).not.toContain('http');
    expect(serializada).not.toContain('llama-local');
  });
});
