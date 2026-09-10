import { DataSource } from 'typeorm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DocumentChunk } from '../documents/document-chunk.entity';
import { DocumentRecord } from '../documents/document.entity';
import { GenerationExecution } from '../gateway/generation-execution.entity';
import { KnowledgeNote } from '../knowledge/knowledge-note.entity';
import { startIntegrationPostgres, type EmbeddedPostgres } from '../test/embedded-postgres';
import { KNOWLEDGE_MIGRATIONS } from '../test/knowledge-migrations';
import { RETENTION_ENV } from './retention-policy';
import { RetentionService } from './retention.service';

const CORRELATION = 'ret-corr';

describe('Retenção contra Postgres real', () => {
  let embedded: EmbeddedPostgres;
  let dataSource: DataSource;
  let service: RetentionService;

  const config = { get: (_key: string, fallback?: unknown) => fallback } as any;

  async function seedExecution(diasAtras: number) {
    await dataSource.query(
      `INSERT INTO generation_executions
         (correlation_id, feature, actor_user_id, activation_id, connection_key,
          connection_revision, model, attempt, status, duration_ms, created_at)
       VALUES ($1, 'chat', 'user-1', 'act-1', 'ollama', 1, 'llama-local', 1, 'succeeded', 10,
               now() - ($2 || ' days')::interval)`,
      [CORRELATION, String(diasAtras)],
    );
  }

  async function executionCount() {
    const rows = await dataSource.query(
      `SELECT count(*)::int AS total FROM generation_executions WHERE correlation_id = $1`,
      [CORRELATION],
    );
    return Number(rows[0].total);
  }

  beforeAll(async () => {
    embedded = await startIntegrationPostgres({
      entities: [DocumentRecord, DocumentChunk, KnowledgeNote, GenerationExecution],
      migrations: KNOWLEDGE_MIGRATIONS,
    });
    dataSource = new DataSource(embedded.options);
    await dataSource.initialize();
    await dataSource.runMigrations();
    service = new RetentionService(config, dataSource);
  }, 120000);

  afterAll(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
    await embedded?.stop();
  });

  beforeEach(async () => {
    await dataSource.query(`DELETE FROM generation_executions WHERE correlation_id = $1`, [CORRELATION]);
  });

  // Variável vazia não é autorização para apagar: inventar um número aqui seria
  // decidir no lugar de quem responde pelos dados.
  it('sujeito sem prazo decidido não apaga nada', async () => {
    await seedExecution(400);

    const relatorio = await service.sweepOnce({});

    expect(await executionCount()).toBe(1);
    expect(relatorio.removed).toBe(0);
    expect(relatorio.pendingDecision).toContain('generationAudit');
  });

  it('linha mais velha que o prazo é removida', async () => {
    await seedExecution(400);
    await seedExecution(1);

    const relatorio = await service.sweepOnce({ [RETENTION_ENV.generationAudit]: '90' });

    expect(await executionCount()).toBe(1);
    expect(relatorio.entries.find((entry) => entry.subject === 'generationAudit'))
      .toMatchObject({ enabled: true, days: 90, removed: 1 });
  });

  it('varrer de novo não remove nada e não falha', async () => {
    await seedExecution(400);
    await service.sweepOnce({ [RETENTION_ENV.generationAudit]: '90' });

    const segunda = await service.sweepOnce({ [RETENTION_ENV.generationAudit]: '90' });

    expect(segunda.removed).toBe(0);
    expect(await executionCount()).toBe(0);
  });

  it('prazo inválido é tratado como decisão ausente', async () => {
    await seedExecution(400);

    const relatorio = await service.sweepOnce({ [RETENTION_ENV.generationAudit]: 'ontem' });

    expect(await executionCount()).toBe(1);
    expect(relatorio.pendingDecision).toContain('generationAudit');
  });

  it('prazo zero ou negativo não apaga o acervo inteiro', async () => {
    await seedExecution(1);

    for (const prazo of ['0', '-30']) {
      const relatorio = await service.sweepOnce({ [RETENTION_ENV.generationAudit]: prazo });
      expect(relatorio.removed).toBe(0);
    }
    expect(await executionCount()).toBe(1);
  });

  // Áudio temporário e transcrição vivem no Norman: a limpeza deles não é
  // deste lado, e dizer o contrário esconderia a pendência real.
  it('sujeito de outro dono aparece como não varrido aqui', async () => {
    const relatorio = await service.sweepOnce({
      [RETENTION_ENV.temporaryAudio]: '7',
      [RETENTION_ENV.transcript]: '30',
    });

    expect(relatorio.entries.find((entry) => entry.subject === 'temporaryAudio'))
      .toMatchObject({ enabled: false, removed: 0 });
    expect(relatorio.entries.find((entry) => entry.subject === 'transcript'))
      .toMatchObject({ enabled: false, removed: 0 });
  });

  it('o lote limita quantas linhas saem por varredura', async () => {
    for (let index = 0; index < 3; index += 1) await seedExecution(400);
    const comLote = new RetentionService(
      { get: (key: string, fallback?: unknown) => (key === 'retention.batchSize' ? 2 : fallback) } as any,
      dataSource,
    );

    const primeira = await comLote.sweepOnce({ [RETENTION_ENV.generationAudit]: '90' });

    expect(primeira.removed).toBe(2);
    expect(await executionCount()).toBe(1);
  });
});
