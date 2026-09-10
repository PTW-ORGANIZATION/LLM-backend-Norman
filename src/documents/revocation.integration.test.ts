import { DataSource } from 'typeorm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DocumentChunk } from './document-chunk.entity';
import { DocumentRecord } from './document.entity';
import { KnowledgeRevocation } from './knowledge-revocation.entity';
import { DocumentChunksService } from './document-chunks.service';
import { DocumentsService } from './documents.service';
import { RevocationsService } from './revocations.service';
import { startIntegrationPostgres, type EmbeddedPostgres } from '../test/embedded-postgres';
import { KNOWLEDGE_MIGRATIONS } from '../test/knowledge-migrations';

const CLIENT = 'it-revoke-acme';
const OTHER_CLIENT = 'it-revoke-rival';
const SCOPE = 'Jonson___Co/01_Brand_Guide';
const SIBLING = 'Jonson___Co/01_Brand_Guias';

function embedding() {
  return Array.from({ length: 768 }, (_, index) => (index % 7) / 10);
}

describe('Revogação com lápide contra Postgres real', () => {
  let embedded: EmbeddedPostgres;
  let dataSource: DataSource;
  let documentsService: DocumentsService;
  let chunksService: DocumentChunksService;
  let revocations: RevocationsService;

  async function seed(scopePath: string, storagePath: string, clientId = CLIENT) {
    const { document } = await documentsService.registerClientDocument({
      scope: 'client',
      clientId,
      scopePath,
      storagePath,
      filename: storagePath.split('/').pop() as string,
      sha256: 'c'.repeat(64),
    });
    await chunksService.replaceForDocument({
      scope: 'client',
      documentId: document.id,
      clientId,
      scopePath,
      embeddingModel: 'nomic-embed-text',
      embeddingDimensions: 768,
      chunks: [{
        chunkIndex: 0,
        pageNumber: 1,
        content: `conteudo de ${storagePath}`,
        embedding: embedding(),
      }],
    });
    return document.id;
  }

  async function found(scopePath: string, clientId = CLIENT) {
    const chunks = await chunksService.searchSimilar({
      scope: { kind: 'client', clientId, scopePath, includeDescendants: true },
      embedding: embedding(),
    });
    return chunks.map((chunk) => chunk.content);
  }

  async function wipe() {
    await dataSource.query(`DELETE FROM document_chunks WHERE client_id = ANY($1)`, [[CLIENT, OTHER_CLIENT]]);
    await dataSource.query(`DELETE FROM documents WHERE client_id = ANY($1)`, [[CLIENT, OTHER_CLIENT]]);
    await dataSource.query(`DELETE FROM knowledge_revocations WHERE client_id = ANY($1)`, [[CLIENT, OTHER_CLIENT]]);
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
    revocations = new RevocationsService(dataSource.getRepository(KnowledgeRevocation));
  }, 120000);

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await wipe();
      await dataSource.destroy();
    }
    await embedded?.stop();
  });

  beforeEach(wipe);

  it('a busca direta deixa de alcançar o que foi revogado', async () => {
    await seed(SCOPE, `${SCOPE}/guia.pdf`);
    await seed(SCOPE, `${SCOPE}/manual.pdf`);

    const result = await revocations.revokePath({
      clientId: CLIENT,
      storagePath: `${SCOPE}/guia.pdf`,
      reason: 'pedido do cliente',
    });

    expect(result).toEqual({ removed: 1, tombstones: 1 });
    expect(await found(SCOPE)).toEqual([`conteudo de ${SCOPE}/manual.pdf`]);
  });

  it('repetir a mesma revogação não duplica trabalho nem muda o resultado', async () => {
    await seed(SCOPE, `${SCOPE}/guia.pdf`);

    const primeira = await revocations.revokePath({ clientId: CLIENT, storagePath: `${SCOPE}/guia.pdf` });
    const segunda = await revocations.revokePath({ clientId: CLIENT, storagePath: `${SCOPE}/guia.pdf` });

    expect(primeira).toEqual({ removed: 1, tombstones: 1 });
    expect(segunda).toEqual({ removed: 0, tombstones: 1 });
    expect(await revocations.listForClient(CLIENT)).toHaveLength(1);
  });

  it('a lápide continua valendo depois de a linha do documento sumir', async () => {
    await seed(SCOPE, `${SCOPE}/guia.pdf`);
    await revocations.revokePath({ clientId: CLIENT, storagePath: `${SCOPE}/guia.pdf` });

    expect(await revocations.isRevoked(CLIENT, `${SCOPE}/guia.pdf`)).toBe(true);
  });

  it('a lápide de uma pasta alcança os arquivos abaixo dela', async () => {
    await seed(SCOPE, `${SCOPE}/guia.pdf`);
    await seed(`${SCOPE}/2026`, `${SCOPE}/2026/plano.pdf`);
    await seed(SIBLING, `${SIBLING}/irmao.pdf`);

    const result = await revocations.revokePrefix({ clientId: CLIENT, scopePath: SCOPE });

    expect(result.removed).toBe(2);
    expect(await revocations.isRevoked(CLIENT, `${SCOPE}/2026/plano.pdf`)).toBe(true);
    expect(await revocations.isRevoked(CLIENT, `${SIBLING}/irmao.pdf`)).toBe(false);
    expect(await found(SIBLING)).toEqual([`conteudo de ${SIBLING}/irmao.pdf`]);
  });

  // `_` é curinga de um caractere no LIKE, e um padrão montado a partir do
  // próprio caminho alcançaria a pasta irmã.
  it('revogar uma pasta não alcança a pasta irmã de nome parecido', async () => {
    await seed(SIBLING, `${SIBLING}/irmao.pdf`);

    await revocations.revokePrefix({ clientId: CLIENT, scopePath: SCOPE });

    expect(await found(SIBLING)).toHaveLength(1);
  });

  it('a lápide de um cliente não alcança o mesmo caminho de outro', async () => {
    await seed(SCOPE, `${SCOPE}/guia.pdf`, OTHER_CLIENT);

    await revocations.revokePath({ clientId: CLIENT, storagePath: `${SCOPE}/guia.pdf` });

    expect(await revocations.isRevoked(OTHER_CLIENT, `${SCOPE}/guia.pdf`)).toBe(false);
    expect(await found(SCOPE, OTHER_CLIENT)).toEqual([`conteudo de ${SCOPE}/guia.pdf`]);
  });

  it('levantar a lápide devolve o caminho ao acervo', async () => {
    await seed(SCOPE, `${SCOPE}/guia.pdf`);
    await revocations.revokePath({ clientId: CLIENT, storagePath: `${SCOPE}/guia.pdf` });

    expect(await revocations.lift(CLIENT, `${SCOPE}/guia.pdf`)).toBe(1);
    expect(await revocations.isRevoked(CLIENT, `${SCOPE}/guia.pdf`)).toBe(false);
  });

  // Restaurar um arquivo não é decisão de restaurar a pasta inteira.
  it('levantar a lápide de um arquivo não levanta a da pasta acima dele', async () => {
    await seed(SCOPE, `${SCOPE}/guia.pdf`);
    await revocations.revokePrefix({ clientId: CLIENT, scopePath: SCOPE });

    await revocations.lift(CLIENT, `${SCOPE}/guia.pdf`);

    expect(await revocations.isRevoked(CLIENT, `${SCOPE}/guia.pdf`)).toBe(true);
  });
});
