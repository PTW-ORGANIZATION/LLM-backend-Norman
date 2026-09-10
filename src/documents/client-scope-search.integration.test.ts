import { DataSource } from 'typeorm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DocumentChunk } from './document-chunk.entity';
import { DocumentRecord } from './document.entity';
import { DocumentChunksService } from './document-chunks.service';
import { DocumentsService } from './documents.service';
import { startIntegrationPostgres, type EmbeddedPostgres } from '../test/embedded-postgres';
import { KNOWLEDGE_MIGRATIONS } from '../test/knowledge-migrations';

const CLIENT = 'it-busca-acme';
const OTHER_CLIENT = 'it-busca-rival';
const PREFIX_CLIENT = 'it-busca-acme-2';

const ROOT = 'Jonson___Co';
const BRAND = `${ROOT}/01_Brand_Guide`;
const SIBLING = `${ROOT}/01_Brand_Guias`;
const DEEP = `${BRAND}/2026/Q1`;
const WILDCARDS = `${ROOT}/100%_Off_[a\\b]`;

function embedding(seed = 1) {
  return Array.from({ length: 768 }, (_, index) => ((index * seed) % 7) / 10);
}

describe('Busca por escopo de cliente contra Postgres com pgvector', () => {
  let embedded: EmbeddedPostgres;
  let dataSource: DataSource;
  let documentsService: DocumentsService;
  let chunksService: DocumentChunksService;

  async function seed(scopePath: string, filename: string, clientId = CLIENT, content?: string) {
    const { document } = await documentsService.registerClientDocument({
      scope: 'client',
      clientId,
      scopePath,
      storagePath: `${scopePath}/${filename}`,
      filename,
      sha256: `${clientId}-${scopePath}-${filename}`.padEnd(64, '0').slice(0, 64),
    });
    await chunksService.replaceForDocument({
      scope: 'client',
      documentId: document.id,
      clientId,
      scopePath,
      embeddingModel: 'nomic-embed-text',
      embeddingDimensions: 768,
      chunks: [
        {
          chunkIndex: 0,
          pageNumber: 1,
          content: content ?? `${clientId} :: ${scopePath}/${filename}`,
          embedding: embedding(),
        },
      ],
    });
    return document.id;
  }

  function contents(rows: Array<{ content: string }>) {
    return rows.map((row) => row.content).sort();
  }

  beforeAll(async () => {
    embedded = await startIntegrationPostgres({
      entities: [DocumentRecord, DocumentChunk],
      migrations: KNOWLEDGE_MIGRATIONS,
    });
    dataSource = new DataSource(embedded.options);
    await dataSource.initialize();
    await dataSource.runMigrations();
    documentsService = new DocumentsService(dataSource.getRepository(DocumentRecord));
    chunksService = new DocumentChunksService(dataSource.getRepository(DocumentChunk));
  }, 120000);

  afterAll(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
    await embedded?.stop();
  });

  beforeEach(async () => {
    const clients = [CLIENT, OTHER_CLIENT, PREFIX_CLIENT];
    await dataSource.query(`DELETE FROM document_chunks WHERE client_id = ANY($1)`, [clients]);
    await dataSource.query(`DELETE FROM documents WHERE client_id = ANY($1)`, [clients]);
  });

  it('recupera a raiz e todos os níveis abaixo dela', async () => {
    await seed(ROOT, 'indice.pdf');
    await seed(BRAND, 'guia.pdf');
    await seed(DEEP, 'campanha.pdf');

    const rows = await chunksService.searchSimilar({
      scope: { kind: 'client', clientId: CLIENT, scopePath: ROOT, includeDescendants: true },
      embedding: embedding(),
    });

    expect(contents(rows)).toEqual([
      `${CLIENT} :: ${DEEP}/campanha.pdf`,
      `${CLIENT} :: ${BRAND}/guia.pdf`,
      `${CLIENT} :: ${ROOT}/indice.pdf`,
    ].sort());
  });

  it('não alcança a pasta irmã cujo nome começa igual', async () => {
    await seed(BRAND, 'guia.pdf');
    await seed(SIBLING, 'outro.pdf');

    const rows = await chunksService.searchSimilar({
      scope: { kind: 'client', clientId: CLIENT, scopePath: BRAND, includeDescendants: true },
      embedding: embedding(),
    });

    expect(contents(rows)).toEqual([`${CLIENT} :: ${BRAND}/guia.pdf`]);
  });

  it('trata %, _, [ e barra invertida como texto, e não como curinga', async () => {
    await seed(WILDCARDS, 'promo.pdf');
    await seed(`${ROOT}/100XXOff_[a\\b]`, 'sosia.pdf');
    await seed(`${WILDCARDS}/detalhe`, 'filho.pdf');

    const rows = await chunksService.searchSimilar({
      scope: { kind: 'client', clientId: CLIENT, scopePath: WILDCARDS, includeDescendants: true },
      embedding: embedding(),
    });

    expect(contents(rows)).toEqual([
      `${CLIENT} :: ${WILDCARDS}/detalhe/filho.pdf`,
      `${CLIENT} :: ${WILDCARDS}/promo.pdf`,
    ].sort());
  });

  it('não devolve o acervo de outro cliente com o caminho idêntico', async () => {
    await seed(BRAND, 'guia.pdf', OTHER_CLIENT, 'ORQUIDEA CROMADA 47');

    const rows = await chunksService.searchSimilar({
      scope: { kind: 'client', clientId: CLIENT, scopePath: ROOT, includeDescendants: true },
      embedding: embedding(),
    });

    expect(rows).toEqual([]);
  });

  it('não devolve o acervo de um cliente cujo id começa igual', async () => {
    await seed(BRAND, 'guia.pdf', PREFIX_CLIENT, 'ORQUIDEA CROMADA 47');

    const rows = await chunksService.searchSimilar({
      scope: { kind: 'client', clientId: CLIENT, scopePath: ROOT, includeDescendants: true },
      embedding: embedding(),
    });

    expect(rows).toEqual([]);
  });

  it('sem descendentes, recupera dos ancestrais e não dos filhos', async () => {
    await seed(ROOT, 'indice.pdf');
    await seed(BRAND, 'guia.pdf');
    await seed(DEEP, 'campanha.pdf');

    const rows = await chunksService.searchSimilar({
      scope: { kind: 'client', clientId: CLIENT, scopePath: BRAND },
      embedding: embedding(),
    });

    expect(contents(rows)).toEqual([
      `${CLIENT} :: ${BRAND}/guia.pdf`,
      `${CLIENT} :: ${ROOT}/indice.pdf`,
    ].sort());
  });

  it('escopo inválido não consulta o banco e devolve vazio', async () => {
    await seed(BRAND, 'guia.pdf');

    for (const scopePath of ['..', `${ROOT}/../${SIBLING}`]) {
      const rows = await chunksService.searchSimilar({
        scope: { kind: 'client', clientId: CLIENT, scopePath, includeDescendants: true },
        embedding: embedding(),
      });
      expect(rows).toEqual([]);
    }
  });

  /**
   * O aceite do cliente com grafias diferentes da mesma raiz.
   *
   * `Jonson & Co` é gravado cru no Drive e sanitizado no Supabase, e a consulta
   * geral mandava só uma grafia presumida: o acervo sob a outra ficava invisível
   * e o cliente recebia acervo vazio sem erro nenhum.
   */
  describe('consulta ao cliente inteiro, com mais de uma grafia da raiz', () => {
    const CRUA = 'Jonson & Co';
    const SANITIZADA = 'Jonson___Co';

    it('recupera o que está sob a grafia crua e sob a sanitizada', async () => {
      await seed(CRUA, 'guia.pdf', CLIENT, 'guia sob a grafia crua');
      await seed(`${SANITIZADA}/01_Brand_Guide`, 'manual.pdf', CLIENT, 'manual sob a grafia sanitizada');

      const rows = await chunksService.searchSimilar({
        scope: { kind: 'client', clientId: CLIENT },
        embedding: embedding(),
      });

      expect(contents(rows)).toEqual([
        'guia sob a grafia crua',
        'manual sob a grafia sanitizada',
      ].sort());
    });

    it('a raiz parecida de outro cliente não entra por aproximação', async () => {
      await seed(CRUA, 'guia.pdf', CLIENT, 'guia da Jonson');
      await seed('Jonson_Co', 'guia.pdf', OTHER_CLIENT, 'guia de outro cliente');

      const rows = await chunksService.searchSimilar({
        scope: { kind: 'client', clientId: CLIENT },
        embedding: embedding(),
      });

      expect(contents(rows)).toEqual(['guia da Jonson']);
    });

    it('02_Briefings continua fora em todas as grafias da raiz', async () => {
      await seed(CRUA, 'guia.pdf', CLIENT, 'conhecimento oficial');
      await seed(`${CRUA}/02_Briefings`, 'anexo.pdf', CLIENT, 'anexo sob a grafia crua');
      await seed(`${SANITIZADA}/02_Briefings/Campanha`, 'anexo.pdf', CLIENT, 'anexo sob a sanitizada');

      const rows = await chunksService.searchSimilar({
        scope: {
          kind: 'client',
          clientId: CLIENT,
          excludeScopePaths: [`${CRUA}/02_Briefings`, `${SANITIZADA}/02_Briefings`],
        },
        embedding: embedding(),
      });

      expect(contents(rows)).toEqual(['conhecimento oficial']);
    });

    // A conversa daquele projeto continua alcançando o anexo: o que a exclusão
    // tira é a consulta ao cliente inteiro, não o acesso autorizado à pasta.
    it('a consulta da própria pasta de briefings continua alcançando o anexo', async () => {
      await seed(`${CRUA}/02_Briefings`, 'anexo.pdf', CLIENT, 'anexo sob a grafia crua');

      const rows = await chunksService.searchSimilar({
        scope: { kind: 'client', clientId: CLIENT, scopePath: `${CRUA}/02_Briefings` },
        embedding: embedding(),
      });

      expect(contents(rows)).toEqual(['anexo sob a grafia crua']);
    });
  });

  it('normaliza o caminho antes de montar o prefixo', async () => {
    await seed(BRAND, 'guia.pdf');
    await seed(DEEP, 'campanha.pdf');

    const rows = await chunksService.searchSimilar({
      scope: {
        kind: 'client',
        clientId: CLIENT,
        scopePath: ` ${ROOT} / 01_Brand_Guide /./ `,
        includeDescendants: true,
      },
      embedding: embedding(),
    });

    expect(contents(rows)).toEqual([
      `${CLIENT} :: ${DEEP}/campanha.pdf`,
      `${CLIENT} :: ${BRAND}/guia.pdf`,
    ].sort());
  });

  it('respeita o modelo de embedding e ainda aceita chunk antigo sem procedência', async () => {
    const documentId = await seed(BRAND, 'guia.pdf');
    await dataSource.query(`UPDATE document_chunks SET embedding_model = NULL WHERE document_id = $1`, [
      documentId,
    ]);
    await seed(DEEP, 'campanha.pdf');

    const compativel = await chunksService.searchSimilar({
      scope: { kind: 'client', clientId: CLIENT, scopePath: ROOT, includeDescendants: true },
      embedding: embedding(),
      embeddingModel: 'nomic-embed-text',
    });
    const outroModelo = await chunksService.searchSimilar({
      scope: { kind: 'client', clientId: CLIENT, scopePath: ROOT, includeDescendants: true },
      embedding: embedding(),
      embeddingModel: 'text-embedding-3-small',
    });

    expect(contents(compativel)).toEqual([
      `${CLIENT} :: ${DEEP}/campanha.pdf`,
      `${CLIENT} :: ${BRAND}/guia.pdf`,
    ].sort());
    expect(contents(outroModelo)).toEqual([`${CLIENT} :: ${BRAND}/guia.pdf`]);
  });
});
