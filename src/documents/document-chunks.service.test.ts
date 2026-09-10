import { DataSource } from 'typeorm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { toSql } from 'pgvector';
import { DocumentChunk } from './document-chunk.entity';
import { DocumentRecord } from './document.entity';
import { DocumentChunksService, type SearchScope } from './document-chunks.service';
import { DocumentsService } from './documents.service';
import { startIntegrationPostgres, type EmbeddedPostgres } from '../test/embedded-postgres';
import { KNOWLEDGE_MIGRATIONS } from '../test/knowledge-migrations';

const CLIENTS = ['acme', 'rival'];
const USER = '11111111-1111-4111-8111-111111111111';
const ORGANIZATION = '22222222-2222-4222-8222-222222222222';
const PROJECT = '33333333-3333-4333-8333-333333333333';

function embedding() {
  return Array.from({ length: 768 }, (_, index) => (index % 7) / 10);
}

describe('DocumentChunksService.searchSimilar', () => {
  let embedded: EmbeddedPostgres;
  let dataSource: DataSource;
  let service: DocumentChunksService;
  let documentsService: DocumentsService;

  async function clientChunk(input: {
    clientId?: string;
    scopePath?: string;
    content: string;
    filename?: string;
    embeddingModel?: string | null;
    pageNumber?: number | null;
  }) {
    const clientId = input.clientId ?? 'acme';
    const scopePath = input.scopePath ?? 'AcmeCorp';
    const filename = input.filename ?? `${input.content.replace(/\W+/g, '-')}.pdf`;
    const { document } = await documentsService.registerClientDocument({
      scope: 'client',
      clientId,
      scopePath,
      storagePath: `${scopePath}/${filename}`,
      filename,
      sha256: `${clientId}-${filename}`.padEnd(64, '0').slice(0, 64),
    });
    await dataSource.query(
      `INSERT INTO document_chunks
         (document_id, knowledge_scope, client_id, scope_path, chunk_index, page_number, content,
          embedding, embedding_model, embedding_dimensions)
       VALUES ($1, 'client', $2, $3, 0, $4, $5, $6::vector, $7, 768)`,
      [
        document.id,
        clientId,
        scopePath,
        input.pageNumber === undefined ? 1 : input.pageNumber,
        input.content,
        toSql(embedding()),
        input.embeddingModel === undefined ? 'nomic-embed-text' : input.embeddingModel,
      ],
    );
    return document.id;
  }

  async function personChunk(input: { content: string; projectId?: string | null }) {
    const { document } = await documentsService.registerClientDocument({
      scope: 'client',
      clientId: 'acme',
      scopePath: 'PastaDePessoa',
      storagePath: `PastaDePessoa/${input.content}.pdf`,
      filename: `${input.content}.pdf`,
      sha256: `pessoa-${input.content}`.padEnd(64, '0').slice(0, 64),
    });
    await dataSource.query(
      `INSERT INTO document_chunks
         (document_id, knowledge_scope, user_id, organization_id, project_id, chunk_index,
          page_number, content, embedding, embedding_model, embedding_dimensions)
       VALUES ($1, 'person', $2, $3, $4, 0, 1, $5, $6::vector, 'nomic-embed-text', 768)`,
      [
        document.id,
        USER,
        ORGANIZATION,
        input.projectId ?? null,
        input.content,
        toSql(embedding()),
      ],
    );
  }

  async function contents(scope: SearchScope, embeddingModel?: string | null) {
    const rows = await service.searchSimilar({ scope, embedding: embedding(), embeddingModel });
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
    service = new DocumentChunksService(dataSource.getRepository(DocumentChunk));
    documentsService = new DocumentsService(dataSource.getRepository(DocumentRecord));
  }, 120000);

  afterAll(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
    await embedded?.stop();
  });

  beforeEach(async () => {
    await dataSource.query(`DELETE FROM document_chunks`);
    await dataSource.query(`DELETE FROM documents WHERE client_id = ANY($1)`, [CLIENTS]);
  });

  describe('isolamento por cliente', () => {
    const acmeVerao: SearchScope = {
      kind: 'client',
      clientId: 'acme',
      scopePath: 'AcmeCorp/Campanhas/Verao2026',
    };

    beforeEach(async () => {
      await clientChunk({ clientId: 'acme', scopePath: 'AcmeCorp', content: 'brand guide da Acme' });
      await clientChunk({
        clientId: 'acme',
        scopePath: 'AcmeCorp/Campanhas/Verao2026',
        content: 'campanha de verao da Acme',
      });
      await clientChunk({
        clientId: 'acme',
        scopePath: 'AcmeCorp/Campanhas/Inverno2026',
        content: 'campanha de inverno da Acme',
      });
      await clientChunk({
        clientId: 'rival',
        scopePath: 'AcmeCorp/Campanhas/Verao2026',
        content: 'segredo da Rival, mesmo caminho de pasta',
      });
      await personChunk({ content: 'nota pessoal do usuario' });
    });

    it('recupera os ancestrais do próprio caminho', async () => {
      expect(await contents(acmeVerao)).toEqual([
        'brand guide da Acme',
        'campanha de verao da Acme',
      ]);
    });

    it('não alcança pasta irmã', async () => {
      expect(await contents(acmeVerao)).not.toContain('campanha de inverno da Acme');
    });

    it('consulta no escopo de outro cliente volta vazia', async () => {
      expect(await contents({
        kind: 'client',
        clientId: 'desconhecido',
        scopePath: 'AcmeCorp/Campanhas/Verao2026',
      })).toEqual([]);
    });

    it('mesmo caminho de pasta em outro cliente não vaza', async () => {
      expect(await contents(acmeVerao)).not.toContain('segredo da Rival, mesmo caminho de pasta');
      expect(await contents({ ...acmeVerao, clientId: 'rival' })).toEqual([
        'segredo da Rival, mesmo caminho de pasta',
      ]);
    });

    it('escopo de cliente não alcança linha de escopo de pessoa', async () => {
      expect(await contents(acmeVerao)).not.toContain('nota pessoal do usuario');
    });

    it('a consulta geral alcança todas as pastas do cliente e nenhuma de outro', async () => {
      expect(await contents({
        kind: 'client',
        clientId: 'acme',
        scopePath: 'AcmeCorp',
        includeDescendants: true,
      })).toEqual([
        'brand guide da Acme',
        'campanha de inverno da Acme',
        'campanha de verao da Acme',
      ]);
    });

    it('escopo de pessoa não alcança linha de escopo de cliente', async () => {
      expect(await contents({
        kind: 'person',
        userId: USER,
        organizationId: ORGANIZATION,
        projectId: null,
      })).toEqual(['nota pessoal do usuario']);
    });
  });

  describe('escopo de pessoa e projeto', () => {
    beforeEach(async () => {
      await personChunk({ content: 'nota geral da pessoa' });
      await personChunk({ content: 'nota do projeto', projectId: PROJECT });
    });

    it('conversa sem projeto recupera só o que não tem projeto', async () => {
      expect(await contents({
        kind: 'person',
        userId: USER,
        organizationId: ORGANIZATION,
        projectId: null,
      })).toEqual(['nota geral da pessoa']);
    });

    it('conversa com projeto recupera o do projeto mais os gerais', async () => {
      expect(await contents({
        kind: 'person',
        userId: USER,
        organizationId: ORGANIZATION,
        projectId: PROJECT,
      })).toEqual(['nota do projeto', 'nota geral da pessoa']);
    });

    it('outra pessoa não alcança a nota desta', async () => {
      expect(await contents({
        kind: 'person',
        userId: '44444444-4444-4444-8444-444444444444',
        organizationId: ORGANIZATION,
        projectId: null,
      })).toEqual([]);
    });
  });

  describe('escopo sem trava não consulta', () => {
    beforeEach(async () => {
      await clientChunk({ clientId: 'acme', scopePath: 'AcmeCorp', content: 'brand guide da Acme' });
    });

    it.each([
      ['caminho de travessia', { kind: 'client', clientId: 'acme', scopePath: 'AcmeCorp/../Rival' }],
      ['caminho só com pontos', { kind: 'client', clientId: 'acme', scopePath: '..' }],
      ['cliente sem id', { kind: 'client', clientId: '', scopePath: 'AcmeCorp' }],
      ['pessoa sem organização', { kind: 'person', userId: USER, organizationId: null, projectId: null }],
    ] as Array<[string, SearchScope]>)('%s devolve vazio', async (_nome, scope) => {
      expect(await contents(scope)).toEqual([]);
    });
  });

  // A consulta geral não passa por caminho: a trava é o `clientId`. Antes ela
  // mandava uma raiz presumida pela identidade do cliente, e o acervo gravado
  // sob a outra grafia legítima ficava invisível.
  describe('consulta ao cliente inteiro, sem caminho', () => {
    it('alcança as duas grafias legítimas da raiz do mesmo cliente', async () => {
      await clientChunk({ clientId: 'acme', scopePath: 'Jonson & Co', content: 'guia sob a grafia crua' });
      await clientChunk({ clientId: 'acme', scopePath: 'Jonson___Co', content: 'guia sob a grafia sanitizada' });

      expect(await contents({ kind: 'client', clientId: 'acme' })).toEqual([
        'guia sob a grafia crua',
        'guia sob a grafia sanitizada',
      ].sort());
    });

    it('caminho em branco vale como consulta ao cliente inteiro', async () => {
      await clientChunk({ clientId: 'acme', scopePath: 'Jonson & Co', content: 'guia da Jonson' });

      expect(await contents({ kind: 'client', clientId: 'acme', scopePath: '   ' }))
        .toEqual(['guia da Jonson']);
    });

    it('não alcança acervo de outro cliente com raiz parecida', async () => {
      await clientChunk({ clientId: 'acme', scopePath: 'Jonson & Co', content: 'guia da Jonson' });
      await clientChunk({ clientId: 'rival', scopePath: 'Jonson_Co', content: 'guia do rival' });

      expect(await contents({ kind: 'client', clientId: 'acme' })).toEqual(['guia da Jonson']);
    });

    it('a pasta de briefings continua excluída em todas as grafias da raiz', async () => {
      await clientChunk({ clientId: 'acme', scopePath: 'Jonson & Co', content: 'guia oficial' });
      await clientChunk({
        clientId: 'acme',
        scopePath: 'Jonson & Co/02_Briefings',
        content: 'anexo de projeto sob a grafia crua',
      });
      await clientChunk({
        clientId: 'acme',
        scopePath: 'Jonson___Co/02_Briefings/Campanha',
        content: 'anexo de projeto sob a grafia sanitizada',
      });

      expect(await contents({
        kind: 'client',
        clientId: 'acme',
        excludeScopePaths: ['Jonson & Co/02_Briefings', 'Jonson___Co/02_Briefings'],
      })).toEqual(['guia oficial']);
    });
  });

  describe('modelo de embedding', () => {
    const escopo: SearchScope = { kind: 'client', clientId: 'acme', scopePath: 'AcmeCorp' };

    beforeEach(async () => {
      await clientChunk({
        clientId: 'acme',
        scopePath: 'AcmeCorp',
        content: 'chunk do modelo em uso',
        embeddingModel: 'nomic-embed-text',
      });
      await clientChunk({
        clientId: 'acme',
        scopePath: 'AcmeCorp',
        content: 'chunk de um modelo antigo',
        embeddingModel: 'outro-modelo',
      });
      await clientChunk({
        clientId: 'acme',
        scopePath: 'AcmeCorp',
        content: 'chunk anterior ao registro de procedencia',
        embeddingModel: null,
      });
    });

    it('não mistura vetor gerado por outro modelo', async () => {
      expect(await contents(escopo, 'nomic-embed-text')).toEqual([
        'chunk anterior ao registro de procedencia',
        'chunk do modelo em uso',
      ]);
    });

    it('sem modelo informado, a consulta traz tudo do escopo', async () => {
      expect(await contents(escopo)).toHaveLength(3);
    });
  });

  describe('pastas fora da consulta ao cliente inteiro', () => {
    beforeEach(async () => {
      await clientChunk({ scopePath: 'AcmeCorp', content: 'brand guide oficial' });
      await clientChunk({ scopePath: 'AcmeCorp/02_Briefings', content: 'anexo solto de briefing' });
      await clientChunk({
        scopePath: 'AcmeCorp/02_Briefings/Verao2026',
        content: 'anexo de projeto',
      });
      await clientChunk({ scopePath: 'AcmeCorp/02_Briefings_Oficiais', content: 'pasta parecida' });
    });

    const inteiro = (excludeScopePaths?: string[]): SearchScope => ({
      kind: 'client',
      clientId: 'acme',
      scopePath: 'AcmeCorp',
      includeDescendants: true,
      ...(excludeScopePaths ? { excludeScopePaths } : {}),
    });

    it('sem exclusão, a consulta ao cliente inteiro alcança tudo', async () => {
      expect(await contents(inteiro())).toHaveLength(4);
    });

    it('a pasta excluída sai da consulta, com tudo abaixo dela', async () => {
      expect(await contents(inteiro(['AcmeCorp/02_Briefings']))).toEqual([
        'brand guide oficial',
        'pasta parecida',
      ]);
    });

    it('pasta de nome parecido não é excluída por engano', async () => {
      const resultado = await contents(inteiro(['AcmeCorp/02_Briefings']));

      expect(resultado).toContain('pasta parecida');
    });

    it('a mesma pasta continua acessível quando a conversa é dela', async () => {
      expect(await contents({
        kind: 'client',
        clientId: 'acme',
        scopePath: 'AcmeCorp/02_Briefings/Verao2026',
      })).toEqual(['anexo de projeto', 'anexo solto de briefing', 'brand guide oficial']);
    });

    it('caminho de exclusão fora da raiz consultada é ignorado', async () => {
      expect(await contents(inteiro(['OutroCliente/02_Briefings']))).toHaveLength(4);
    });

    it('caminho de exclusão com travessia é descartado', async () => {
      expect(await contents(inteiro(['AcmeCorp/../OutroCliente', '   ']))).toHaveLength(4);
    });

    it('excluir a própria raiz devolve vazio, sem consultar meio-termo', async () => {
      expect(await contents(inteiro(['AcmeCorp']))).toEqual([]);
    });

    it('a exclusão é normalizada como o resto dos caminhos', async () => {
      expect(await contents(inteiro([' AcmeCorp / 02_Briefings /./ ']))).toEqual([
        'brand guide oficial',
        'pasta parecida',
      ]);
    });

    it('duas exclusões repetidas não repetem o filtro', async () => {
      expect(await contents(inteiro(['AcmeCorp/02_Briefings', 'AcmeCorp/02_Briefings']))).toEqual([
        'brand guide oficial',
        'pasta parecida',
      ]);
    });
  });

  describe('procedência do trecho', () => {
    it('cada trecho carrega documento, arquivo, caminho, chunk, página e relevância', async () => {
      const documentId = await clientChunk({
        clientId: 'acme',
        scopePath: 'AcmeCorp/01_Brand',
        content: 'a cor da marca é azul-cobalto',
        filename: 'guia-de-marca.pdf',
        pageNumber: 7,
      });

      const [trecho] = await service.searchSimilar({
        scope: { kind: 'client', clientId: 'acme', scopePath: 'AcmeCorp/01_Brand' },
        embedding: embedding(),
      });

      expect(trecho).toMatchObject({
        content: 'a cor da marca é azul-cobalto',
        documentId,
        filename: 'guia-de-marca.pdf',
        storagePath: 'AcmeCorp/01_Brand/guia-de-marca.pdf',
        scopePath: 'AcmeCorp/01_Brand',
        chunkIndex: 0,
        pageNumber: 7,
        embeddingModel: 'nomic-embed-text',
      });
      expect(trecho.distance).toBeCloseTo(0, 5);
      expect(trecho.similarity).toBeCloseTo(1, 5);
    });

    it('formato sem paginação não ganha página inventada', async () => {
      await clientChunk({
        clientId: 'acme',
        scopePath: 'AcmeCorp',
        content: 'planilha sem paginas',
        filename: 'tabela.xlsx',
        pageNumber: null,
      });

      const [trecho] = await service.searchSimilar({
        scope: { kind: 'client', clientId: 'acme', scopePath: 'AcmeCorp' },
        embedding: embedding(),
      });

      expect(trecho.pageNumber).toBeNull();
    });

    it('a distância cresce quando o vetor procurado é outro', async () => {
      await clientChunk({ clientId: 'acme', scopePath: 'AcmeCorp', content: 'trecho' });

      const [trecho] = await service.searchSimilar({
        scope: { kind: 'client', clientId: 'acme', scopePath: 'AcmeCorp' },
        embedding: Array.from({ length: 768 }, (_, index) => (index % 3 === 0 ? 1 : 0)),
      });

      expect(trecho.distance).toBeGreaterThan(0);
      expect(trecho.similarity).toBeLessThan(1);
    });
  });
});
