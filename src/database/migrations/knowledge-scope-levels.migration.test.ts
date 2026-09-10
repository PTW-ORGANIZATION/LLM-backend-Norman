import { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DocumentChunk } from '../../documents/document-chunk.entity';
import { DocumentRecord } from '../../documents/document.entity';
import { KnowledgeRevocation } from '../../documents/knowledge-revocation.entity';
import { KnowledgeNote } from '../../knowledge/knowledge-note.entity';
import { startIntegrationPostgres, type EmbeddedPostgres } from '../../test/embedded-postgres';
import { KNOWLEDGE_MIGRATIONS } from '../../test/knowledge-migrations';

const CLIENT = 'mig-cliente';
const SCOPE = 'MigCliente/01_Brand';
const SYSTEM_ROOT = '_Conhecimento geral do sistema';
const ZERO_VECTOR = `[${Array.from({ length: 768 }, () => 0).join(',')}]`;
const PESSOA = '11111111-1111-4111-8111-111111111111';
const ORGANIZACAO = '22222222-2222-4222-8222-222222222222';
const PROJETO = '33333333-3333-4333-8333-333333333333';

/**
 * A migração do discriminador de nível, subindo e descendo num PostgreSQL limpo.
 *
 * A prova que interessa não é só "roda sem erro": é que as linhas que já
 */
describe('migração KnowledgeScopeLevels', () => {
  let embedded: EmbeddedPostgres;
  let comMigracao: DataSource;
  let documentoDeCliente: string;

  async function migrationsAte(nome: string) {
    const indice = KNOWLEDGE_MIGRATIONS.findIndex((m) => m.name === nome);
    return KNOWLEDGE_MIGRATIONS.slice(0, indice);
  }

  beforeAll(async () => {
    embedded = await startIntegrationPostgres({
      entities: [DocumentRecord, DocumentChunk, KnowledgeNote, KnowledgeRevocation],
      migrations: await migrationsAte('KnowledgeScopeLevels1757800000000'),
    });

    // O estado de antes: um documento de cliente com chunk, nota e lápide.
    // Nenhuma dessas linhas conhece a coluna nova, e é exatamente por isso que
    // elas provam a classificação.
    const semMigracao = new DataSource(embedded.options);
    await semMigracao.initialize();
    await semMigracao.runMigrations();

    await semMigracao.query(
      `INSERT INTO organizations (id, name) VALUES ($1, 'Organização de teste')`,
      [ORGANIZACAO],
    );
    await semMigracao.query(
      `INSERT INTO users (id, email, password_hash, name, organization_id)
       VALUES ($1, 'pessoa@teste.local', 'hash', 'Pessoa de teste', $2)`,
      [PESSOA, ORGANIZACAO],
    );
    await semMigracao.query(
      `INSERT INTO projects (id, organization_id, name) VALUES ($1, $2, 'Projeto de teste')`,
      [PROJETO, ORGANIZACAO],
    );

    const [{ id: documentId }] = await semMigracao.query(
      `INSERT INTO documents (client_id, scope_path, storage_path, filename, sha256, status)
       VALUES ($1, $2, $3, 'antigo.pdf', $4, 'ready')
       RETURNING id`,
      [CLIENT, SCOPE, `${SCOPE}/antigo.pdf`, 'a'.repeat(64)],
    );
    documentoDeCliente = documentId;
    await semMigracao.query(
      `INSERT INTO document_chunks
         (document_id, client_id, scope_path, chunk_index, content, embedding, embedding_dimensions)
       VALUES ($1, $2, $3, 0, 'texto antigo', $4::vector, 768)`,
      [documentId, CLIENT, SCOPE, ZERO_VECTOR],
    );
    await semMigracao.query(
      `INSERT INTO knowledge_notes
         (document_id, client_id, scope_path, kind, model, generator_version,
          source_fingerprint, content)
       VALUES ($1, $2, $3, 'document_summary', 'llama3.1:8b', 2, $4, '{"resumo":"antigo"}'::jsonb)`,
      [documentId, CLIENT, SCOPE, 'a'.repeat(64)],
    );
    await semMigracao.query(
      `INSERT INTO knowledge_revocations (client_id, kind, path, revoked_at)
       VALUES ($1, 'path', $2, now())`,
      [CLIENT, `${SCOPE}/removido.pdf`],
    );

    await semMigracao.destroy();

    comMigracao = new DataSource({ ...embedded.options, migrations: KNOWLEDGE_MIGRATIONS });
    await comMigracao.initialize();
    await comMigracao.query(`
      CREATE OR REPLACE FUNCTION tentativa_de_escrita(comando text) RETURNS text AS $$
      BEGIN
        EXECUTE comando;
        RETURN NULL;
      EXCEPTION WHEN others THEN
        RETURN SQLERRM;
      END;
      $$ LANGUAGE plpgsql;
    `);
  }, 180000);

  afterAll(async () => {
    if (comMigracao?.isInitialized) await comMigracao.destroy();
    await embedded?.stop();
  });

  async function colunaExiste(tabela: string, coluna: string) {
    const rows = await comMigracao.query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_name = $1 AND column_name = $2`,
      [tabela, coluna],
    );
    return Array.isArray(rows) && rows.length > 0;
  }

  function literal(valor: unknown): string {
    if (valor === null || valor === undefined) return 'NULL';
    if (typeof valor === 'number') return String(valor);
    return `'${String(valor).replace(/'/g, "''")}'`;
  }

  async function tentarEscrita(sql: string): Promise<string | null> {
    const [linha] = await comMigracao.query('SELECT tentativa_de_escrita($1) AS recusa', [sql]);
    return linha.recusa ?? null;
  }

  async function contarSistema() {
    const [linha] = await comMigracao.query(`
      SELECT
        (SELECT count(*) FROM "documents" WHERE "knowledge_scope" = 'system')::int AS documentos,
        (SELECT count(*) FROM "document_chunks" WHERE "knowledge_scope" = 'system')::int AS chunks,
        (SELECT count(*) FROM "knowledge_notes" WHERE "knowledge_scope" = 'system')::int AS notas,
        (SELECT count(*) FROM "knowledge_revocations" WHERE "knowledge_scope" = 'system')::int
          AS revogacoes
    `);
    return linha;
  }

  it('classifica as linhas preexistentes ao subir, sem inventar nível geral', async () => {
    expect(await colunaExiste('documents', 'knowledge_scope')).toBe(false);

    const pendentes = KNOWLEDGE_MIGRATIONS.filter(
      (m) => m.name === 'KnowledgeScopeLevels1757800000000',
    );
    expect(pendentes).toHaveLength(1);
    await comMigracao.runMigrations();

    const documentos = await comMigracao.query(
      `SELECT knowledge_scope, client_id FROM documents`,
    );
    expect(documentos).toEqual([{ knowledge_scope: 'client', client_id: CLIENT }]);
    const chunks = await comMigracao.query(`SELECT knowledge_scope FROM document_chunks`);
    expect(chunks).toEqual([{ knowledge_scope: 'client' }]);
    const notas = await comMigracao.query(`SELECT knowledge_scope FROM knowledge_notes`);
    expect(notas).toEqual([{ knowledge_scope: 'client' }]);
    const lapides = await comMigracao.query(`SELECT knowledge_scope FROM knowledge_revocations`);
    expect(lapides).toEqual([{ knowledge_scope: 'client' }]);

    expect((await contarSistema()).documentos).toBe(0);
  }, 180000);

  it('a lápide geral é única pelo caminho, e a de cliente pelo par cliente + caminho', async () => {
    await comMigracao.query(
      `INSERT INTO knowledge_revocations (knowledge_scope, client_id, kind, path, revoked_at)
       VALUES ('system', NULL, 'path', $1, now())`,
      [`${SYSTEM_ROOT}/saiu.pdf`],
    );

    const duplicada = await tentarEscrita(
      `INSERT INTO knowledge_revocations (knowledge_scope, client_id, kind, path, revoked_at)
       VALUES ('system', NULL, 'path', ${literal(`${SYSTEM_ROOT}/saiu.pdf`)}, now())`,
    );
    expect(String(duplicada)).toMatch(/uq_knowledge_revocations_system_target/);

    await comMigracao.query(
      `DELETE FROM knowledge_revocations WHERE knowledge_scope = 'system'`,
    );
  });

  describe('o banco recusa nível e dono incompatíveis', () => {
    async function documento(colunas: Record<string, unknown>) {
      const base: Record<string, unknown> = {
        knowledge_scope: 'client',
        user_id: null,
        organization_id: null,
        project_id: null,
        client_id: CLIENT,
        scope_path: SCOPE,
        storage_path: `${SCOPE}/tentativa-${Math.random()}.pdf`,
        filename: 'tentativa.pdf',
        status: 'pending',
        ...colunas,
      };
      const chaves = Object.keys(base);
      return tentarEscrita(
        `INSERT INTO documents (${chaves.map((chave) => `"${chave}"`).join(', ')})
         VALUES (${chaves.map((chave) => literal(base[chave])).join(', ')})`,
      );
    }

    async function chunk(colunas: Record<string, unknown>) {
      const base: Record<string, unknown> = {
        document_id: documentoDeCliente,
        knowledge_scope: 'client',
        user_id: null,
        organization_id: null,
        project_id: null,
        client_id: CLIENT,
        scope_path: SCOPE,
        chunk_index: Math.floor(Math.random() * 1_000_000),
        content: 'tentativa',
        embedding_dimensions: 768,
        ...colunas,
      };
      const chaves = Object.keys(base);
      return tentarEscrita(
        `INSERT INTO document_chunks (${chaves.map((chave) => `"${chave}"`).join(', ')}, "embedding")
         VALUES (${chaves.map((chave) => literal(base[chave])).join(', ')},
                 '${ZERO_VECTOR}'::vector)`,
      );
    }

    const INVALIDAS: Array<[string, Record<string, unknown>]> = [
      ['pessoa sem pessoa', { knowledge_scope: 'person', user_id: null, organization_id: ORGANIZACAO, client_id: null, scope_path: null }],
      ['pessoa sem organização', { knowledge_scope: 'person', user_id: PESSOA, organization_id: null, client_id: null, scope_path: null }],
      ['pessoa com cliente', { knowledge_scope: 'person', user_id: PESSOA, organization_id: ORGANIZACAO, client_id: CLIENT, scope_path: null }],
      ['cliente sem cliente', { knowledge_scope: 'client', client_id: null }],
      ['cliente sem caminho', { knowledge_scope: 'client', scope_path: null }],
      ['cliente com pessoa', { knowledge_scope: 'client', user_id: PESSOA }],
      ['cliente com organização', { knowledge_scope: 'client', organization_id: ORGANIZACAO }],
      ['cliente com projeto', { knowledge_scope: 'client', project_id: PROJETO }],
      ['sistema com cliente', { knowledge_scope: 'system', client_id: CLIENT, scope_path: SYSTEM_ROOT }],
      ['sistema sem caminho', { knowledge_scope: 'system', client_id: null, scope_path: null }],
      ['sistema com pessoa', { knowledge_scope: 'system', client_id: null, scope_path: SYSTEM_ROOT, user_id: PESSOA }],
      ['sistema com organização', { knowledge_scope: 'system', client_id: null, scope_path: SYSTEM_ROOT, organization_id: ORGANIZACAO }],
      ['sistema com projeto', { knowledge_scope: 'system', client_id: null, scope_path: SYSTEM_ROOT, project_id: PROJETO }],
      ['nível inexistente', { knowledge_scope: 'geral', client_id: null, scope_path: SYSTEM_ROOT }],
    ];

    const VALIDAS: Array<[string, Record<string, unknown>]> = [
      ['pessoa com pessoa e organização', { knowledge_scope: 'person', user_id: PESSOA, organization_id: ORGANIZACAO, client_id: null, scope_path: null }],
      ['pessoa com projeto', { knowledge_scope: 'person', user_id: PESSOA, organization_id: ORGANIZACAO, project_id: PROJETO, client_id: null, scope_path: null }],
      ['cliente com cliente e caminho', { knowledge_scope: 'client' }],
      ['sistema sem dono e com caminho', { knowledge_scope: 'system', client_id: null, scope_path: SYSTEM_ROOT }],
    ];

    it('documento: toda combinação inválida de nível e dono é recusada pelo CHECK', async () => {
      const recusas: Array<[string, string | null]> = [];
      for (const [caso, colunas] of INVALIDAS) recusas.push([caso, await documento(colunas)]);

      for (const [caso, recusa] of recusas) {
        expect(`${caso}: ${recusa}`).toMatch(/chk_documents_scope/);
      }
    });

    it('trecho: toda combinação inválida de nível e dono é recusada pelo CHECK', async () => {
      const recusas: Array<[string, string | null]> = [];
      for (const [caso, colunas] of INVALIDAS) recusas.push([caso, await chunk(colunas)]);

      for (const [caso, recusa] of recusas) {
        expect(`${caso}: ${recusa}`).toMatch(/chk_document_chunks_scope/);
      }
    });

    it('documento: as combinações válidas de cada nível continuam aceitas', async () => {
      const recusas: Array<[string, string | null]> = [];
      for (const [caso, colunas] of VALIDAS) recusas.push([caso, await documento(colunas)]);

      expect(recusas.filter(([, recusa]) => recusa !== null)).toEqual([]);
    });

    it('trecho: as combinações válidas de cada nível continuam aceitas', async () => {
      const recusas: Array<[string, string | null]> = [];
      for (const [caso, colunas] of VALIDAS) recusas.push([caso, await chunk(colunas)]);

      expect(recusas.filter(([, recusa]) => recusa !== null)).toEqual([]);
    });

    it('nota de cliente exige cliente e nota geral exige ausência dele', async () => {
      const nota = (scope: string, clientId: string | null) => tentarEscrita(
        `INSERT INTO knowledge_notes
           (document_id, knowledge_scope, client_id, scope_path, kind, model, generator_version,
            source_fingerprint, content)
         VALUES (${literal(documentoDeCliente)}, ${literal(scope)}, ${literal(clientId)},
                 ${literal(SCOPE)}, 'document_summary', 'llama3.1:8b', 2,
                 ${literal(`${Math.random()}`.padEnd(64, '0').slice(0, 64))}, '{}'::jsonb)`,
      );

      for (const [caso, tentativa] of [
        ['nota de cliente sem cliente', () => nota('client', null)],
        ['nota geral com cliente', () => nota('system', CLIENT)],
        ['nota de nível inexistente', () => nota('geral', null)],
      ] as Array<[string, () => Promise<string | null>]>) {
        expect(`${caso}: ${await tentativa()}`).toMatch(/chk_knowledge_notes_owner/);
      }
    });

    it('lápide de cliente exige cliente e lápide geral exige ausência dele', async () => {
      const lapide = (scope: string, clientId: string | null) => tentarEscrita(
        `INSERT INTO knowledge_revocations (knowledge_scope, client_id, kind, path, revoked_at)
         VALUES (${literal(scope)}, ${literal(clientId)}, 'path',
                 ${literal(`${SCOPE}/tentativa-${Math.random()}.pdf`)}, now())`,
      );

      for (const [caso, tentativa] of [
        ['lápide de cliente sem cliente', () => lapide('client', null)],
        ['lápide geral com cliente', () => lapide('system', CLIENT)],
        ['lápide de nível inexistente', () => lapide('geral', null)],
      ] as Array<[string, () => Promise<string | null>]>) {
        expect(`${caso}: ${await tentativa()}`).toMatch(/chk_knowledge_revocations_owner/);
      }
    });
  });

  describe('reversão', () => {
    it('com conteúdo geral, a reversão falha antes de apagar qualquer linha', async () => {
      const [{ id: geralId }] = await comMigracao.query(
        `INSERT INTO documents
           (knowledge_scope, client_id, scope_path, storage_path, filename, sha256, status)
         VALUES ('system', NULL, $1, $2, 'manual.pdf', $3, 'ready')
         RETURNING id`,
        [SYSTEM_ROOT, `${SYSTEM_ROOT}/manual.pdf`, 'b'.repeat(64)],
      );
      await comMigracao.query(
        `INSERT INTO document_chunks
           (document_id, knowledge_scope, client_id, scope_path, chunk_index, content,
            embedding, embedding_dimensions)
         VALUES ($1, 'system', NULL, $2, 0, 'regra geral', $3::vector, 768)`,
        [geralId, SYSTEM_ROOT, ZERO_VECTOR],
      );
      await comMigracao.query(
        `INSERT INTO knowledge_notes
           (document_id, knowledge_scope, client_id, scope_path, kind, model, generator_version,
            source_fingerprint, content)
         VALUES ($1, 'system', NULL, $2, 'document_summary', 'llama3.1:8b', 2, $3, '{}'::jsonb)`,
        [geralId, SYSTEM_ROOT, 'c'.repeat(64)],
      );
      await comMigracao.query(
        `INSERT INTO knowledge_revocations (knowledge_scope, client_id, kind, path, revoked_at)
         VALUES ('system', NULL, 'path', $1, now())`,
        [`${SYSTEM_ROOT}/removido.pdf`],
      );

      const antesSistema = await contarSistema();
      const [antesCliente] = await comMigracao.query(`
        SELECT
          (SELECT count(*) FROM "documents" WHERE "knowledge_scope" <> 'system')::int AS documentos,
          (SELECT count(*) FROM "document_chunks" WHERE "knowledge_scope" <> 'system')::int AS chunks
      `);

      const recusa = await comMigracao.undoLastMigration().then(
        () => null,
        (erro: Error) => erro.message,
      );
      expect(recusa).toMatch(/acervo geral do sistema tem conteúdo/);

      expect(await contarSistema()).toEqual(antesSistema);
      const [depoisCliente] = await comMigracao.query(`
        SELECT
          (SELECT count(*) FROM "documents" WHERE "knowledge_scope" <> 'system')::int AS documentos,
          (SELECT count(*) FROM "document_chunks" WHERE "knowledge_scope" <> 'system')::int AS chunks
      `);
      expect(depoisCliente).toEqual(antesCliente);
      expect(await colunaExiste('documents', 'knowledge_scope')).toBe(true);
    }, 180000);

    it('sem conteúdo geral, a reversão desce e a subida volta a classificar', async () => {
      await comMigracao.query(`DELETE FROM knowledge_revocations WHERE knowledge_scope = 'system'`);
      await comMigracao.query(`DELETE FROM knowledge_notes WHERE knowledge_scope = 'system'`);
      await comMigracao.query(`DELETE FROM document_chunks WHERE knowledge_scope = 'system'`);
      await comMigracao.query(`DELETE FROM documents WHERE knowledge_scope = 'system'`);
      await comMigracao.query(`DELETE FROM document_chunks WHERE knowledge_scope = 'person'`);
      await comMigracao.query(`DELETE FROM documents WHERE knowledge_scope = 'person'`);

      const clientesAntes = await comMigracao.query(
        `SELECT count(*)::int AS total FROM documents WHERE knowledge_scope = 'client'`,
      );

      await comMigracao.undoLastMigration();

      expect(await colunaExiste('documents', 'knowledge_scope')).toBe(false);
      expect(await colunaExiste('document_chunks', 'knowledge_scope')).toBe(false);
      expect(await colunaExiste('knowledge_notes', 'knowledge_scope')).toBe(false);
      expect(await colunaExiste('knowledge_revocations', 'knowledge_scope')).toBe(false);

      const restantes = await comMigracao.query(
        `SELECT count(*)::int AS total FROM documents`,
      );
      expect(restantes).toEqual(clientesAntes);

      await comMigracao.runMigrations();
      expect(await colunaExiste('documents', 'knowledge_scope')).toBe(true);
      const reclassificados = await comMigracao.query(
        `SELECT DISTINCT knowledge_scope FROM documents`,
      );
      expect(reclassificados).toEqual([{ knowledge_scope: 'client' }]);
    }, 180000);
  });
});
