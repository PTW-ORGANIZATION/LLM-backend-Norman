import { DataSource } from 'typeorm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ConnectionActivation } from './connection-activation.entity';
import { ConnectionRevision } from './connection-revision.entity';
import { ConnectionRevisionsService } from './connection-revisions.service';
import { startIntegrationPostgres, type EmbeddedPostgres } from '../test/embedded-postgres';
import { KNOWLEDGE_MIGRATIONS } from '../test/knowledge-migrations';

const AMBIENTE = {
  OLLAMA_MODEL: 'llama-local',
  OLLAMA_ALLOWED_MODELS: 'llama-local,llama-grande',
  GROK_API_KEY: 'chave-do-grok',
  GROK_MODEL: 'grok-x',
};

describe('registro de revisões de conexão', () => {
  let embedded: EmbeddedPostgres;
  let dataSource: DataSource;
  let service: ConnectionRevisionsService;
  let original: Record<string, string | undefined>;

  beforeAll(async () => {
    embedded = await startIntegrationPostgres({
      entities: [ConnectionRevision, ConnectionActivation],
      migrations: KNOWLEDGE_MIGRATIONS,
    });
    dataSource = new DataSource(embedded.options);
    await dataSource.initialize();
    await dataSource.runMigrations();
    service = new ConnectionRevisionsService(
      dataSource.getRepository(ConnectionRevision),
      dataSource.getRepository(ConnectionActivation),
    );

    original = {};
    for (const [chave, valor] of Object.entries(AMBIENTE)) {
      original[chave] = process.env[chave];
      process.env[chave] = valor;
    }
  }, 120000);

  afterAll(async () => {
    for (const [chave, valor] of Object.entries(original)) {
      if (valor === undefined) delete process.env[chave];
      else process.env[chave] = valor;
    }
    if (dataSource?.isInitialized) await dataSource.destroy();
    await embedded?.stop();
  });

  beforeEach(async () => {
    await dataSource.query('DELETE FROM connection_activations');
    await dataSource.query('DELETE FROM connection_revisions');
  });

  it('a sincronização vincula chave, revisão, modelo e digest da configuração', async () => {
    const record = await service.sync({ connectionKey: 'ollama', revision: 1, model: 'llama-local' });

    expect(record).toMatchObject({
      connectionKey: 'ollama',
      revision: 1,
      model: 'llama-local',
      isEnabled: true,
    });
    expect(record.configDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('sincronizar de novo os mesmos valores é idempotente', async () => {
    const primeira = await service.sync({ connectionKey: 'ollama', revision: 1, model: 'llama-local' });
    const segunda = await service.sync({ connectionKey: 'ollama', revision: 1, model: 'llama-local' });

    expect(segunda.configDigest).toBe(primeira.configDigest);
    expect(await dataSource.query('SELECT count(*)::int AS total FROM connection_revisions'))
      .toEqual([{ total: 1 }]);
  });

  // O vínculo é imutável: sem isso, trocar o modelo de uma revisão já aprovada
  // transformaria a aprovação de um modelo em aprovação de outro.
  it('a mesma revisão com outro modelo é recusada', async () => {
    await service.sync({ connectionKey: 'ollama', revision: 1, model: 'llama-local' });

    await expect(service.sync({ connectionKey: 'ollama', revision: 1, model: 'llama-grande' }))
      .rejects.toThrow(/já foi reconhecida com o modelo/);
  });

  it('modelo fora da allowlist do executor não vira revisão', async () => {
    await expect(service.sync({ connectionKey: 'ollama', revision: 1, model: 'modelo-de-fora' }))
      .rejects.toThrow(/não está entre os permitidos/);
  });

  it('conexão sem provisionamento neste backend não vira revisão', async () => {
    const anterior = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      await expect(service.sync({ connectionKey: 'openai', revision: 1, model: 'gpt' }))
        .rejects.toThrow(/defina OPENAI_API_KEY/);
    } finally {
      if (anterior === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = anterior;
    }
  });

  it('nada do segredo nem da URL sai no registro', async () => {
    const record = await service.sync({ connectionKey: 'grok', revision: 1, model: 'grok-x' });

    const serializado = JSON.stringify(record);
    expect(serializado).not.toContain('chave-do-grok');
    expect(serializado).not.toContain('api.x.ai');
  });

  describe('resolução exata de chave e revisão', () => {
    beforeEach(async () => {
      await service.sync({ connectionKey: 'ollama', revision: 1, model: 'llama-local' });
      await service.confirmActivation({ connectionKey: 'ollama', revision: 1, activationId: 'act-1' });
    });

    it('a revisão registrada resolve com o modelo dela', async () => {
      const { record, connection } = await service.require({
        connectionKey: 'ollama',
        revision: 1,
        activationId: 'act-1',
      });

      expect(record.model).toBe('llama-local');
      expect(connection.key).toBe('ollama');
    });

    it('revisão inexistente é recusada', async () => {
      await expect(service.require({ connectionKey: 'ollama', revision: 2 }))
        .rejects.toThrow(/não é reconhecida/);
    });

    it('revisão de outra conexão não vale para esta', async () => {
      await expect(service.require({ connectionKey: 'grok', revision: 1 }))
        .rejects.toThrow(/não é reconhecida/);
    });

    it('revisão desabilitada é recusada', async () => {
      await service.sync({
        connectionKey: 'ollama',
        revision: 1,
        model: 'llama-local',
        enabled: false,
      });

      await expect(service.require({ connectionKey: 'ollama', revision: 1 }))
        .rejects.toThrow(/desabilitada/);
    });

    it('modelo divergente do registrado é recusado', async () => {
      await expect(service.require({ connectionKey: 'ollama', revision: 1, model: 'llama-grande' }))
        .rejects.toThrow(/foi reconhecida com o modelo/);
    });

    it('ativação inventada é recusada', async () => {
      await expect(service.require({
        connectionKey: 'ollama',
        revision: 1,
        activationId: 'act-inventada',
      })).rejects.toThrow(/não está confirmada neste backend/);
    });

    it('ativação de outra revisão não vale para esta', async () => {
      await service.sync({ connectionKey: 'ollama', revision: 2, model: 'llama-grande' });

      await expect(service.require({
        connectionKey: 'ollama',
        revision: 2,
        activationId: 'act-1',
      })).rejects.toThrow(/e não para a revisão 2/);
    });

    it('revisão sem ativação confirmada não é executável', async () => {
      await service.sync({ connectionKey: 'ollama', revision: 2, model: 'llama-grande' });

      await expect(service.require({
        connectionKey: 'ollama',
        revision: 2,
        activationId: 'act-que-ninguem-confirmou',
      })).rejects.toThrow(/não está confirmada neste backend/);
    });

    // Sem `activationId` no pedido, a revisão resolve para teste e fallback:
    // aprovar uma configuração não é executá-la em nome de uma ativação.
    it('sem identidade informada, a revisão resolve sem ativação', async () => {
      const resolvida = await service.require({ connectionKey: 'ollama', revision: 1 });
      expect(resolvida.activation).toBeNull();
    });

    // Trocar a credencial ou o destino invalida a aprovação: o digest muda, e
    // a revisão aprovada sobre a configuração antiga deixa de resolver.
    it('mudar o provisionamento invalida a revisão já reconhecida', async () => {
      const anterior = process.env.OLLAMA_ALLOWED_MODELS;
      process.env.OLLAMA_ALLOWED_MODELS = 'llama-local,llama-grande,llama-nova';
      try {
        await expect(service.require({ connectionKey: 'ollama', revision: 1 }))
          .rejects.toThrow(/sobre outro provisionamento/);
      } finally {
        process.env.OLLAMA_ALLOWED_MODELS = anterior;
      }
    });
  });

  describe('confirmação de ativação', () => {
    it('só uma revisão reconhecida pode ser confirmada', async () => {
      await expect(service.confirmActivation({
        connectionKey: 'ollama',
        revision: 9,
        activationId: 'act-1',
      })).rejects.toThrow(/não é reconhecida/);
    });

    it('revisão desabilitada não pode ser confirmada', async () => {
      await service.sync({
        connectionKey: 'ollama',
        revision: 1,
        model: 'llama-local',
        enabled: false,
      });

      await expect(service.confirmActivation({
        connectionKey: 'ollama',
        revision: 1,
        activationId: 'act-1',
      })).rejects.toThrow(/desabilitada/);
    });

    it('confirmar registra identidade, chave, revisão e modelo aprovado', async () => {
      await service.sync({ connectionKey: 'ollama', revision: 1, model: 'llama-local' });

      const confirmada = await service.confirmActivation({
        connectionKey: 'ollama',
        revision: 1,
        activationId: 'act-7',
      });

      expect(confirmada).toMatchObject({
        activationId: 'act-7',
        connectionKey: 'ollama',
        revision: 1,
        model: 'llama-local',
      });
    });

    /**
     * A repetição depois de um timeout é o caso normal: quem chamou não sabe se
     * a confirmação chegou. Repetir com a mesma tupla precisa descobrir que ela
     * chegou, e não criar uma segunda linha nem responder erro.
     */
    it('repetir a mesma tupla é idempotente', async () => {
      await service.sync({ connectionKey: 'ollama', revision: 1, model: 'llama-local' });

      const primeira = await service.confirmActivation({
        connectionKey: 'ollama',
        revision: 1,
        activationId: 'act-7',
      });
      const segunda = await service.confirmActivation({
        connectionKey: 'ollama',
        revision: 1,
        activationId: 'act-7',
      });

      expect(segunda.confirmedAt.getTime()).toBe(primeira.confirmedAt.getTime());
      expect(await dataSource.query('SELECT count(*)::int AS total FROM connection_activations'))
        .toEqual([{ total: 1 }]);
    });

    it('a mesma identidade apontando para outra revisão é recusada', async () => {
      await service.sync({ connectionKey: 'ollama', revision: 1, model: 'llama-local' });
      await service.sync({ connectionKey: 'ollama', revision: 2, model: 'llama-grande' });
      await service.confirmActivation({ connectionKey: 'ollama', revision: 1, activationId: 'act-7' });

      await expect(service.confirmActivation({
        connectionKey: 'ollama',
        revision: 2,
        activationId: 'act-7',
      })).rejects.toThrow(/use uma identidade nova para outra revisão/);
    });

    /**
     * O defeito que a linha própria fecha: enquanto a ativação era um campo da
     * revisão, a tentativa seguinte gravava a identidade nova por cima, e uma
     * falha depois disso deixava a ativação anterior — que continuava sendo a
     * vigente do outro lado — sem resolver.
     */
    it('confirmar uma tentativa nova não apaga o vínculo válido anterior', async () => {
      await service.sync({ connectionKey: 'ollama', revision: 1, model: 'llama-local' });
      await service.confirmActivation({ connectionKey: 'ollama', revision: 1, activationId: 'act-antiga' });
      await service.confirmActivation({ connectionKey: 'ollama', revision: 1, activationId: 'act-nova' });

      await expect(service.require({
        connectionKey: 'ollama',
        revision: 1,
        activationId: 'act-antiga',
      })).resolves.toMatchObject({ activation: { activationId: 'act-antiga' } });
      await expect(service.require({
        connectionKey: 'ollama',
        revision: 1,
        activationId: 'act-nova',
      })).resolves.toMatchObject({ activation: { activationId: 'act-nova' } });
    });

    // Duas confirmações simultâneas da mesma identidade: uma perde a corrida no
    // índice único e precisa ler a linha da que ganhou, porque para quem chamou
    // as duas são a mesma operação repetida.
    it('duas confirmações simultâneas da mesma identidade resolvem em uma linha', async () => {
      await service.sync({ connectionKey: 'ollama', revision: 1, model: 'llama-local' });

      const resultados = await Promise.all([
        service.confirmActivation({ connectionKey: 'ollama', revision: 1, activationId: 'act-corrida' }),
        service.confirmActivation({ connectionKey: 'ollama', revision: 1, activationId: 'act-corrida' }),
      ]);

      expect(resultados[0].activationId).toBe('act-corrida');
      expect(resultados[1].activationId).toBe('act-corrida');
      expect(await dataSource.query('SELECT count(*)::int AS total FROM connection_activations'))
        .toEqual([{ total: 1 }]);
    });

    it('a confirmação de uma identidade pode ser consultada, para reconciliação', async () => {
      await service.sync({ connectionKey: 'ollama', revision: 1, model: 'llama-local' });
      await service.confirmActivation({ connectionKey: 'ollama', revision: 1, activationId: 'act-7' });

      expect(await service.findActivation('act-7')).toMatchObject({
        activationId: 'act-7',
        connectionKey: 'ollama',
        revision: 1,
      });
      expect(await service.findActivation('act-que-nunca-existiu')).toBeNull();
      expect(await service.findActivation('  ')).toBeNull();
    });

    it('as confirmações de uma revisão são listáveis', async () => {
      await service.sync({ connectionKey: 'ollama', revision: 1, model: 'llama-local' });
      await service.confirmActivation({ connectionKey: 'ollama', revision: 1, activationId: 'act-a' });
      await service.confirmActivation({ connectionKey: 'ollama', revision: 1, activationId: 'act-b' });

      const confirmadas = await service.activationsOf('ollama', 1);
      expect(confirmadas.map((item) => item.activationId).sort()).toEqual(['act-a', 'act-b']);
      expect(await service.activationsOf('ollama', 2)).toEqual([]);
      expect(await service.activationsOf('ollama', -1)).toEqual([]);
    });

    it('o retrato da revisão traz as identidades confirmadas', async () => {
      await service.sync({ connectionKey: 'ollama', revision: 1, model: 'llama-local' });
      await service.sync({ connectionKey: 'ollama', revision: 2, model: 'llama-grande' });
      await service.confirmActivation({ connectionKey: 'ollama', revision: 2, activationId: 'act-2' });

      const retrato = await service.describe('ollama');
      expect(retrato.map((item) => [item.revision, item.activationIds])).toEqual([
        [2, ['act-2']],
        [1, []],
      ]);
    });

    it('conexão sem revisão nenhuma tem retrato vazio', async () => {
      expect(await service.describe('grok')).toEqual([]);
    });

    it('identidade em branco não confirma nada', async () => {
      await service.sync({ connectionKey: 'ollama', revision: 1, model: 'llama-local' });

      await expect(service.confirmActivation({
        connectionKey: 'ollama',
        revision: 1,
        activationId: '   ',
      })).rejects.toThrow(/precisa de um identificador/);
    });

    // Trocar o provisionamento depois da confirmação invalida a ativação: o
    // digest deixa de bater, e a geração para antes do provedor.
    it('confirmação sobre outro provisionamento deixa de valer', async () => {
      await service.sync({ connectionKey: 'ollama', revision: 1, model: 'llama-local' });
      await service.confirmActivation({ connectionKey: 'ollama', revision: 1, activationId: 'act-7' });

      const anterior = process.env.OLLAMA_ALLOWED_MODELS;
      process.env.OLLAMA_ALLOWED_MODELS = 'llama-local,llama-grande,llama-nova';
      try {
        await expect(service.require({
          connectionKey: 'ollama',
          revision: 1,
          activationId: 'act-7',
        })).rejects.toThrow(/sobre outro provisionamento/);
      } finally {
        process.env.OLLAMA_ALLOWED_MODELS = anterior;
      }
    });
  });
});
