import { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toSql } from 'pgvector';
import { DocumentChunk } from './document-chunk.entity';
import { DocumentRecord } from './document.entity';
import { DocumentChunksService, type SearchScope } from './document-chunks.service';
import { DocumentsService } from './documents.service';
import { RevocationsService } from './revocations.service';
import { KnowledgeRevocation } from './knowledge-revocation.entity';
import { startIntegrationPostgres, type EmbeddedPostgres } from '../test/embedded-postgres';
import { KNOWLEDGE_MIGRATIONS } from '../test/knowledge-migrations';

const CLIENT_A = 'sys-cliente-a';
const CLIENT_B = 'sys-cliente-b';
const SYSTEM_ROOT = '_Conhecimento geral do sistema';

function embedding() {
  return Array.from({ length: 768 }, (_, index) => (index % 5) / 10);
}

/**
 * As duas camadas no banco de verdade, com o discriminador imposto pelo CHECK.
 *
 * O que estas provas fecham é o defeito que o plano descreve: a camada geral
 * não pode ser "consulta sem filtro de cliente". Ela tem um filtro próprio, e
 * uma linha que tentar ser das duas coisas nem chega a existir.
 */
describe('acervo geral do sistema ao lado do acervo de cliente', () => {
  let embedded: EmbeddedPostgres;
  let dataSource: DataSource;
  let documentsService: DocumentsService;
  let chunksService: DocumentChunksService;
  let revocationsService: RevocationsService;

  async function seedClient(clientId: string, filename: string, content: string) {
    const scopePath = `${clientId}/01_Brand`;
    const { document } = await documentsService.registerClientDocument({
      scope: 'client',
      clientId,
      scopePath,
      storagePath: `${scopePath}/${filename}`,
      filename,
      sha256: `${clientId}-${filename}`.padEnd(64, '0').slice(0, 64),
    });
    await chunksService.replaceForDocument({
      documentId: document.id,
      scope: 'client',
      clientId,
      scopePath,
      embeddingModel: 'nomic-embed-text',
      embeddingDimensions: 768,
      chunks: [{ chunkIndex: 0, pageNumber: 1, content, embedding: embedding() }],
    });
    return document.id;
  }

  async function seedSystem(filename: string, content: string, folder = SYSTEM_ROOT) {
    const { document } = await documentsService.registerClientDocument({
      scope: 'system',
      clientId: null,
      scopePath: folder,
      storagePath: `${folder}/${filename}`,
      filename,
      sha256: `system-${filename}`.padEnd(64, '0').slice(0, 64),
    });
    await chunksService.replaceForDocument({
      documentId: document.id,
      scope: 'system',
      clientId: null,
      scopePath: folder,
      embeddingModel: 'nomic-embed-text',
      embeddingDimensions: 768,
      chunks: [{ chunkIndex: 0, pageNumber: 1, content, embedding: embedding() }],
    });
    return document.id;
  }

  async function contents(scope: SearchScope) {
    const rows = await chunksService.searchSimilar({
      scope,
      embedding: embedding(),
      embeddingModel: 'nomic-embed-text',
    });
    return rows.map((row) => row.content).sort();
  }

  beforeAll(async () => {
    embedded = await startIntegrationPostgres({
      entities: [DocumentRecord, DocumentChunk, KnowledgeRevocation],
      migrations: KNOWLEDGE_MIGRATIONS,
    });
    dataSource = new DataSource(embedded.options);
    await dataSource.initialize();
    await dataSource.runMigrations();
    documentsService = new DocumentsService(dataSource.getRepository(DocumentRecord));
    chunksService = new DocumentChunksService(dataSource.getRepository(DocumentChunk));
    revocationsService = new RevocationsService(dataSource.getRepository(KnowledgeRevocation));

    await seedClient(CLIENT_A, 'marca-a.pdf', 'a cor do cliente A e azul-cobalto');
    await seedClient(CLIENT_B, 'marca-b.pdf', 'a cor do cliente B e verde-musgo');
    await seedSystem('tom-de-voz.pdf', 'o tom de voz do Norman e direto e sem jargao');
  }, 180000);

  afterAll(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
    await embedded?.stop();
  });

  it('a fonte geral aparece na consulta do cliente A', async () => {
    expect(await contents({ kind: 'system' })).toContain(
      'o tom de voz do Norman e direto e sem jargao',
    );
    expect(await contents({ kind: 'client', clientId: CLIENT_A })).toEqual([
      'a cor do cliente A e azul-cobalto',
    ]);
  });

  it('a mesma fonte geral aparece na consulta do cliente B', async () => {
    expect(await contents({ kind: 'system' })).toContain(
      'o tom de voz do Norman e direto e sem jargao',
    );
    expect(await contents({ kind: 'client', clientId: CLIENT_B })).toEqual([
      'a cor do cliente B e verde-musgo',
    ]);
  });

  it('a fonte privada de A nunca aparece para B, e vice-versa', async () => {
    const deA = await contents({ kind: 'client', clientId: CLIENT_A });
    const deB = await contents({ kind: 'client', clientId: CLIENT_B });

    expect(deA).not.toContain('a cor do cliente B e verde-musgo');
    expect(deB).not.toContain('a cor do cliente A e azul-cobalto');
  });

  // A consulta geral não é a consulta de cliente sem `clientId`: ela filtra
  // pelo nível, e por isso não alcança acervo privado de ninguém.
  it('a consulta geral não alcança acervo privado de nenhum cliente', async () => {
    const geral = await contents({ kind: 'system' });

    expect(geral).not.toContain('a cor do cliente A e azul-cobalto');
    expect(geral).not.toContain('a cor do cliente B e verde-musgo');
    expect(geral).toEqual(['o tom de voz do Norman e direto e sem jargao']);
  });

  it('a consulta de cliente não alcança o acervo geral', async () => {
    expect(await contents({ kind: 'client', clientId: CLIENT_A })).not.toContain(
      'o tom de voz do Norman e direto e sem jargao',
    );
  });

  it('pasta excluída do acervo geral fica fora da consulta geral', async () => {
    const rascunho = `${SYSTEM_ROOT}/99_Rascunhos`;
    await seedSystem('nao-aprovado.pdf', 'rascunho geral que ninguem aprovou', rascunho);

    expect(await contents({ kind: 'system' })).toContain('rascunho geral que ninguem aprovou');
    expect(
      await contents({ kind: 'system', excludeScopePaths: [rascunho] }),
    ).not.toContain('rascunho geral que ninguem aprovou');
  });

  it('escopo inválido é recusado antes de gravar linha nenhuma', async () => {
    await expect(
      documentsService.registerClientDocument({
        scope: 'system',
        clientId: '__system__',
        scopePath: SYSTEM_ROOT,
        storagePath: `${SYSTEM_ROOT}/sintetico.pdf`,
        filename: 'sintetico.pdf',
        sha256: 'f'.repeat(64),
      }),
    ).rejects.toThrow(/não pertence a nenhum cliente/);

    await expect(
      documentsService.registerClientDocument({
        scope: 'client',
        clientId: null,
        scopePath: 'PastaSemDono',
        storagePath: 'PastaSemDono/orfao.pdf',
        filename: 'orfao.pdf',
        sha256: 'e'.repeat(64),
      }),
    ).rejects.toThrow(/exige clientId/);
  });

  // O banco é a última trava: mesmo um INSERT direto, sem passar pelo serviço,
  // não consegue criar uma linha que pertença a um cliente e a todos.
  it('o banco recusa linha geral com cliente e linha de cliente sem cliente', async () => {
    await expect(
      dataSource.query(
        `INSERT INTO documents (knowledge_scope, client_id, scope_path, storage_path, filename, sha256)
         VALUES ('system', 'acme', 'x', 'x/a.pdf', 'a.pdf', $1)`,
        ['a'.repeat(64)],
      ),
    ).rejects.toThrow(/chk_documents_scope/);

    await expect(
      dataSource.query(
        `INSERT INTO documents (knowledge_scope, client_id, scope_path, storage_path, filename, sha256)
         VALUES ('client', NULL, 'x', 'x/b.pdf', 'b.pdf', $1)`,
        ['b'.repeat(64)],
      ),
    ).rejects.toThrow(/chk_documents_scope/);
  });

  it('revogação geral confirmada tira a fonte de A e de B na mesma chamada', async () => {
    const folder = `${SYSTEM_ROOT}/Compartilhado`;
    await seedSystem('regra-comum.pdf', 'a regra geral compartilhada com todos', folder);
    expect(await contents({ kind: 'system' })).toContain('a regra geral compartilhada com todos');

    const result = await revocationsService.revokePath({
      scope: 'system',
      clientId: null,
      storagePath: `${folder}/regra-comum.pdf`,
      reason: 'saiu de circulação',
    });

    expect(result).toMatchObject({ removed: 1, tombstones: 1 });
    const depois = await contents({ kind: 'system' });
    expect(depois).not.toContain('a regra geral compartilhada com todos');
    // O acervo dos dois clientes continua intacto: a revogação era da camada
    // geral, e ela não pode levar o conhecimento privado de ninguém embora.
    expect(await contents({ kind: 'client', clientId: CLIENT_A })).toContain(
      'a cor do cliente A e azul-cobalto',
    );
    expect(await contents({ kind: 'client', clientId: CLIENT_B })).toContain(
      'a cor do cliente B e verde-musgo',
    );
  });

  it('revogar duas vezes o mesmo caminho geral é a mesma lápide', async () => {
    const folder = `${SYSTEM_ROOT}/Duplicado`;
    await seedSystem('uma-vez.pdf', 'conteudo geral revogado duas vezes', folder);
    const alvo = `${folder}/uma-vez.pdf`;

    const primeira = await revocationsService.revokePath({
      scope: 'system',
      clientId: null,
      storagePath: alvo,
    });
    const segunda = await revocationsService.revokePath({
      scope: 'system',
      clientId: null,
      storagePath: alvo,
    });

    expect(primeira).toMatchObject({ removed: 1, tombstones: 1 });
    expect(segunda).toMatchObject({ removed: 0, tombstones: 1 });
    expect(await revocationsService.isRevoked(null, alvo, 'system')).toBe(true);
    // A lápide geral não revoga o caminho homônimo de um cliente.
    expect(await revocationsService.isRevoked(CLIENT_A, alvo, 'client')).toBe(false);
  });

  it('a lápide geral e a de cliente com o mesmo caminho são independentes', async () => {
    const caminho = `${SYSTEM_ROOT}/homonimo.pdf`;

    await revocationsService.revokePath({ scope: 'system', clientId: null, storagePath: caminho });
    expect(await revocationsService.isRevoked(null, caminho, 'system')).toBe(true);
    expect(await revocationsService.isRevoked(CLIENT_A, caminho, 'client')).toBe(false);

    await revocationsService.revokePath({
      scope: 'client',
      clientId: CLIENT_A,
      storagePath: caminho,
    });
    expect(await revocationsService.isRevoked(CLIENT_A, caminho, 'client')).toBe(true);
    expect(await revocationsService.isRevoked(CLIENT_B, caminho, 'client')).toBe(false);

    await revocationsService.lift(null, caminho, 'system');
    expect(await revocationsService.isRevoked(null, caminho, 'system')).toBe(false);
    expect(await revocationsService.isRevoked(CLIENT_A, caminho, 'client')).toBe(true);
  });

  it('a lápide geral não aceita cliente', async () => {
    await expect(
      revocationsService.revokePath({
        scope: 'system',
        clientId: 'acme',
        storagePath: `${SYSTEM_ROOT}/recusado.pdf`,
      }),
    ).rejects.toThrow(/não pertence a nenhum cliente/);
  });
});
