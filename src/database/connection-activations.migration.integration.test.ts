import { DataSource } from 'typeorm';
import { afterEach, describe, expect, it } from 'vitest';
import { startIntegrationPostgres, type EmbeddedPostgres } from '../test/embedded-postgres';
import { KNOWLEDGE_MIGRATIONS } from '../test/knowledge-migrations';
import { ConnectionActivations1757700000000 } from './migrations/1757700000000-ConnectionActivations';

/**
 * A migration do registro de ativações, exercida contra PostgreSQL de verdade.
 *
 * Duas subidas precisam funcionar: banco vazio e o estado que as migrations
 * atuais já produzem em dev e em produção. A segunda é a que importa, porque
 * `connection_revisions.activation_id` pode ter ativações válidas gravadas — e
 * uma migration que as ignorasse derrubaria a geração de quem estava no ar.
 */

const ANTERIORES = KNOWLEDGE_MIGRATIONS.filter(
  (migration) => migration !== ConnectionActivations1757700000000,
);

async function abrir(migrations: EmbeddedPostgres['options']['migrations']) {
  const embedded = await startIntegrationPostgres({ entities: [], migrations });
  const dataSource = new DataSource(embedded.options);
  await dataSource.initialize();
  return {
    dataSource,
    async fechar() {
      if (dataSource.isInitialized) await dataSource.destroy();
      await embedded.stop();
    },
  };
}

async function indicesDe(dataSource: DataSource, tabela: string): Promise<string[]> {
  const rows = await dataSource.query(
    `SELECT indexname FROM pg_indexes WHERE tablename = $1 ORDER BY indexname`,
    [tabela],
  );
  return rows.map((row: { indexname: string }) => row.indexname);
}

describe('migration do registro de ativações', () => {
  let aberto: Awaited<ReturnType<typeof abrir>> | null = null;

  afterEach(async () => {
    await aberto?.fechar();
    aberto = null;
  });

  it('sobe sobre banco vazio, com a unicidade da identidade', async () => {
    aberto = await abrir(KNOWLEDGE_MIGRATIONS);
    await aberto.dataSource.runMigrations();

    const colunas = await aberto.dataSource.query(
      `SELECT column_name, is_nullable FROM information_schema.columns
       WHERE table_name = 'connection_activations' ORDER BY column_name`,
    );
    expect(colunas.map((coluna: any) => coluna.column_name)).toEqual([
      'activation_id',
      'config_digest',
      'confirmed_at',
      'connection_key',
      'id',
      'model',
      'revision',
    ]);

    const indices = await indicesDe(aberto.dataSource, 'connection_activations');
    expect(indices).toContain('uq_connection_activations_activation');
    expect(indices).toContain('uq_connection_activations_identity');
    expect(indices).toContain('idx_connection_activations_revision');
  }, 120000);

  it('o índice único recusa a mesma identidade em duas revisões', async () => {
    aberto = await abrir(KNOWLEDGE_MIGRATIONS);
    await aberto.dataSource.runMigrations();

    await aberto.dataSource.query(
      `INSERT INTO connection_activations
         (activation_id, connection_key, revision, model, config_digest)
       VALUES ('act-1', 'ollama', 1, 'llama-local', 'digest-1')`,
    );

    await expect(aberto.dataSource.query(
      `INSERT INTO connection_activations
         (activation_id, connection_key, revision, model, config_digest)
       VALUES ('act-1', 'ollama', 2, 'llama-grande', 'digest-1')`,
    )).rejects.toThrow(/uq_connection_activations_activation/);
  }, 120000);

  /**
   * O estado real de quem já rodou as migrations anteriores: revisões
   * reconhecidas, algumas com ativação gravada na coluna herdada. A subida tem
   * de preservar essas ativações, porque elas continuam sendo as vigentes do
   * outro lado.
   */
  it('sobe sobre o estado das migrations atuais e preserva a ativação já gravada', async () => {
    aberto = await abrir(ANTERIORES);
    await aberto.dataSource.runMigrations();

    await aberto.dataSource.query(
      `INSERT INTO connection_revisions
         (connection_key, revision, model, config_digest, is_enabled, activation_id)
       VALUES
         ('ollama', 1, 'llama-local', 'digest-antigo', true, 'act-vigente'),
         ('ollama', 2, 'llama-grande', 'digest-antigo', true, NULL),
         ('grok', 1, 'grok-x', 'digest-grok', true, 'act-grok')`,
    );

    const runner = aberto.dataSource.createQueryRunner();
    try {
      await new ConnectionActivations1757700000000().up(runner);
    } finally {
      await runner.release();
    }

    const confirmadas = await aberto.dataSource.query(
      `SELECT activation_id, connection_key, revision, model, config_digest
       FROM connection_activations ORDER BY activation_id`,
    );
    expect(confirmadas).toEqual([
      {
        activation_id: 'act-grok',
        connection_key: 'grok',
        revision: 1,
        model: 'grok-x',
        config_digest: 'digest-grok',
      },
      {
        activation_id: 'act-vigente',
        connection_key: 'ollama',
        revision: 1,
        model: 'llama-local',
        config_digest: 'digest-antigo',
      },
    ]);

    // A coluna herdada continua onde estava: a migration é aditiva e não
    // reescreve o que já foi gravado.
    const herdada = await aberto.dataSource.query(
      `SELECT activation_id FROM connection_revisions
       WHERE connection_key = 'ollama' AND revision = 1`,
    );
    expect(herdada).toEqual([{ activation_id: 'act-vigente' }]);
  }, 120000);

  it('subir a migration duas vezes não duplica nem falha', async () => {
    aberto = await abrir(ANTERIORES);
    await aberto.dataSource.runMigrations();
    await aberto.dataSource.query(
      `INSERT INTO connection_revisions
         (connection_key, revision, model, config_digest, is_enabled, activation_id)
       VALUES ('ollama', 1, 'llama-local', 'digest-antigo', true, 'act-vigente')`,
    );

    const migration = new ConnectionActivations1757700000000();
    const runner = aberto.dataSource.createQueryRunner();
    try {
      await migration.up(runner);
      await migration.up(runner);
    } finally {
      await runner.release();
    }

    expect(await aberto.dataSource.query(
      `SELECT count(*)::int AS total FROM connection_activations`,
    )).toEqual([{ total: 1 }]);
  }, 120000);

  it('a queda derruba só a tabela nova', async () => {
    aberto = await abrir(KNOWLEDGE_MIGRATIONS);
    await aberto.dataSource.runMigrations();

    const runner = aberto.dataSource.createQueryRunner();
    try {
      await new ConnectionActivations1757700000000().down(runner);
    } finally {
      await runner.release();
    }

    expect(await indicesDe(aberto.dataSource, 'connection_activations')).toEqual([]);
    expect(await indicesDe(aberto.dataSource, 'connection_revisions')).not.toEqual([]);
  }, 120000);
});
