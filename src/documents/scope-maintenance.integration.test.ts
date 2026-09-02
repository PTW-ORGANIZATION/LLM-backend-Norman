import { DataSource } from 'typeorm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DocumentChunk } from './document-chunk.entity';
import { DocumentRecord } from './document.entity';
import { DocumentChunksService } from './document-chunks.service';
import { DocumentsService } from './documents.service';

// Roda contra um Postgres com pgvector de verdade. Fica de fora da suíte padrão
// porque exige infraestrutura: só liga com INGESTION_IT_DATABASE apontando para
// um banco DESCARTÁVEL — nunca o banco que serve produção.
const DATABASE = process.env.INGESTION_IT_DATABASE;
const describeIntegration = DATABASE ? describe : describe.skip;

const CLIENT = 'it-scope-acme';
const OTHER_CLIENT = 'it-scope-rival';

// A pasta com `_` é a que importa: `_` é curinga de um caractere no LIKE, e um
// padrão montado a partir do próprio caminho casaria a pasta irmã.
const BRAND = 'Jonson___Co/01_Brand_Guide';
const SIBLING = 'Jonson___Co/01_Brand_Guias';
const CHILD = `${BRAND}/2026`;

function embedding() {
  return Array.from({ length: 768 }, (_, index) => (index % 7) / 10);
}

describeIntegration('Manutenção de escopo contra Postgres real', () => {
  let dataSource: DataSource;
  let documentsService: DocumentsService;
  let chunksService: DocumentChunksService;

  async function seed(scopePath: string, storagePath: string, clientId = CLIENT) {
    const { document } = await documentsService.registerClientDocument({
      clientId,
      scopePath,
      storagePath,
      filename: storagePath.split('/').pop() as string,
      sha256: 'c'.repeat(64),
    });
    await chunksService.replaceForDocument({
      documentId: document.id,
      clientId,
      scopePath,
      chunks: [{ chunkIndex: 0, pageNumber: 1, content: `conteudo de ${storagePath}`, embedding: embedding() }],
    });
    return document.id;
  }

  async function scopes(table: 'documents' | 'document_chunks') {
    const rows = await dataSource.query(
      `SELECT scope_path FROM ${table} WHERE client_id = ANY($1) ORDER BY scope_path`,
      [[CLIENT, OTHER_CLIENT]],
    );
    return rows.map((row: { scope_path: string }) => row.scope_path);
  }

  async function wipe() {
    await dataSource.query(`DELETE FROM document_chunks WHERE client_id = ANY($1)`, [[CLIENT, OTHER_CLIENT]]);
    await dataSource.query(`DELETE FROM documents WHERE client_id = ANY($1)`, [[CLIENT, OTHER_CLIENT]]);
  }

  beforeAll(async () => {
    dataSource = new DataSource({
      type: 'postgres',
      host: process.env.DB_HOST || '127.0.0.1',
      port: parseInt(process.env.DB_PORT || '5432', 10),
      username: process.env.DB_USERNAME,
      password: process.env.DB_PASSWORD,
      database: DATABASE,
      entities: [DocumentRecord, DocumentChunk],
      synchronize: false,
    });
    await dataSource.initialize();
    documentsService = new DocumentsService(dataSource.getRepository(DocumentRecord));
    chunksService = new DocumentChunksService(dataSource.getRepository(DocumentChunk));
  }, 60000);

  afterAll(async () => {
    if (!dataSource?.isInitialized) return;
    await wipe();
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await wipe();
  });

  it('esquece um arquivo pelo caminho, levando os chunks junto', async () => {
    await seed(BRAND, `${BRAND}/guia.pdf`);
    await seed(BRAND, `${BRAND}/manual.pdf`);

    const removed = await documentsService.forgetPath({
      clientId: CLIENT,
      storagePath: `${BRAND}/guia.pdf`,
    });

    expect(removed).toBe(1);
    expect(await scopes('documents')).toHaveLength(1);
    expect(await scopes('document_chunks')).toHaveLength(1);
  });

  it('não esquece o arquivo de outro cliente no mesmo caminho', async () => {
    await seed(BRAND, `${BRAND}/guia.pdf`, OTHER_CLIENT);

    const removed = await documentsService.forgetPath({
      clientId: CLIENT,
      storagePath: `${BRAND}/guia.pdf`,
    });

    expect(removed).toBe(0);
    expect(await scopes('documents')).toEqual([BRAND]);
  });

  it('esquece a pasta e o que está abaixo dela, sem tocar na pasta irmã', async () => {
    await seed(BRAND, `${BRAND}/guia.pdf`);
    await seed(CHILD, `${CHILD}/anexo.pdf`);
    await seed(SIBLING, `${SIBLING}/outro.pdf`);

    const removed = await documentsService.forgetPrefix({ clientId: CLIENT, scopePath: BRAND });

    expect(removed).toBe(2);
    expect(await scopes('documents')).toEqual([SIBLING]);
    expect(await scopes('document_chunks')).toEqual([SIBLING]);
  });

  it('renomeia a pasta por prefixo, sem revetorizar e sem tocar na irmã', async () => {
    const documentId = await seed(BRAND, `${BRAND}/guia.pdf`);
    await seed(CHILD, `${CHILD}/anexo.pdf`);
    await seed(SIBLING, `${SIBLING}/outro.pdf`);

    const [{ embedding: antes }] = await dataSource.query(
      `SELECT embedding FROM document_chunks WHERE document_id = $1`,
      [documentId],
    );

    const updated = await documentsService.renamePrefix({
      clientId: CLIENT,
      fromPath: BRAND,
      toPath: 'Jonson___Co/01_Marca',
    });

    expect(updated).toBe(2);
    expect(await scopes('documents')).toEqual([
      SIBLING,
      'Jonson___Co/01_Marca',
      'Jonson___Co/01_Marca/2026',
    ]);
    expect(await scopes('document_chunks')).toEqual([
      SIBLING,
      'Jonson___Co/01_Marca',
      'Jonson___Co/01_Marca/2026',
    ]);

    const [{ embedding: depois }] = await dataSource.query(
      `SELECT embedding FROM document_chunks WHERE document_id = $1`,
      [documentId],
    );
    expect(depois).toEqual(antes);

    const [{ storage_path: storagePath }] = await dataSource.query(
      `SELECT storage_path FROM documents WHERE id = $1`,
      [documentId],
    );
    expect(storagePath).toBe('Jonson___Co/01_Marca/guia.pdf');
  });

  it('não renomeia a pasta de outro cliente', async () => {
    await seed(BRAND, `${BRAND}/guia.pdf`, OTHER_CLIENT);

    const updated = await documentsService.renamePrefix({
      clientId: CLIENT,
      fromPath: BRAND,
      toPath: 'Jonson___Co/01_Marca',
    });

    expect(updated).toBe(0);
    expect(await scopes('documents')).toEqual([BRAND]);
  });

  it('a busca passa a recuperar pelo caminho novo, e não pelo antigo', async () => {
    await seed(BRAND, `${BRAND}/guia.pdf`);

    await documentsService.renamePrefix({
      clientId: CLIENT,
      fromPath: BRAND,
      toPath: 'Jonson___Co/01_Marca',
    });

    const noCaminhoNovo = await chunksService.searchSimilar({
      scope: { kind: 'client', clientId: CLIENT, scopePath: 'Jonson___Co/01_Marca' },
      embedding: embedding(),
    });
    const noCaminhoAntigo = await chunksService.searchSimilar({
      scope: { kind: 'client', clientId: CLIENT, scopePath: BRAND },
      embedding: embedding(),
    });

    expect(noCaminhoNovo).toHaveLength(1);
    expect(noCaminhoAntigo).toEqual([]);
  });
});
