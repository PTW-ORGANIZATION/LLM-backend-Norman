import fs from 'node:fs';
import path from 'node:path';
import { DataSource } from 'typeorm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DocumentChunk } from '../documents/document-chunk.entity';
import { DocumentRecord } from '../documents/document.entity';
import { DocumentChunksService } from '../documents/document-chunks.service';
import { DocumentsService } from '../documents/documents.service';
import { chunkPages } from './chunking';
import { TextExtractionService } from './extraction/text-extraction.service';
import { startIntegrationPostgres, type EmbeddedPostgres } from '../test/embedded-postgres';
import { KNOWLEDGE_MIGRATIONS } from '../test/knowledge-migrations';

const CLIENT = 'it-formatos-acme';
const SCOPE = 'AcmeCorp/01_Brand';
const FIXTURES = path.join(__dirname, 'extraction', '__fixtures__');

const CONFIG = {
  'ingestion.maxFileBytes': 104857600,
  'ingestion.maxExpandedFileBytes': 314572800,
  'ingestion.maxSheets': 100,
  'ingestion.maxSlides': 300,
  'ingestion.ocrMaxPages': 0,
  'ingestion.slideOcrMaxImages': 0,
  'ingestion.chunkSize': 1200,
  'ingestion.chunkOverlap': 150,
} as Record<string, unknown>;

const FORMATOS = [
  { arquivo: 'legado.doc', mimeType: 'application/msword', source: 'doc', paginado: false },
  {
    arquivo: 'legado.xls',
    mimeType: 'application/vnd.ms-excel',
    source: 'xls',
    paginado: true,
  },
  {
    arquivo: 'apresentacao.pptx',
    mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    source: 'pptx',
    paginado: true,
  },
] as const;

/**
 * O PDF fica fora da tabela de propósito.
 *
 * Ele tem um caso só, e não os três de cada formato legado: esta suíte sobe
 * PostgreSQL embarcado e roda ao lado das outras suítes de integração, e cada
 * ingestão a mais aproxima o conjunto do ponto em que uma delas falha por
 * disputa de recurso, não por defeito. Um caminho completo basta para provar
 * que o PDF atravessa extração, chunk, gravação e recuperação.
 */
const PDF = {
  arquivo: 'guia-marca.pdf',
  mimeType: 'application/pdf',
  source: 'pdf-text-layer',
} as const;

/**
 * Embedding determinístico por texto.
 *
 * O Ollama não está disponível nesta suíte, e o que se mede aqui é o caminho do
 * conteúdo — extração, chunk, gravação, recuperação e procedência —, não a
 * qualidade da similaridade. Cada texto gera um vetor estável, então buscar
 * pelo vetor de um chunk recupera aquele chunk.
 */
function embeddingOf(text: string) {
  const vector = Array.from({ length: 768 }, () => 0);
  for (let index = 0; index < text.length; index += 1) {
    vector[text.charCodeAt(index) % 768] += 1;
  }
  const norm = Math.sqrt(vector.reduce((total, value) => total + value * value, 0)) || 1;
  return vector.map((value) => value / norm);
}

describe('DOC, XLS e PPTX do upload à citação', () => {
  let embedded: EmbeddedPostgres;
  let dataSource: DataSource;
  let documentsService: DocumentsService;
  let chunksService: DocumentChunksService;
  let extraction: TextExtractionService;

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
    extraction = new TextExtractionService(
      { get: (key: string, fallback?: unknown) => CONFIG[key] ?? fallback } as never,
      { describeImages: async () => [] } as never,
    );
  }, 120000);

  afterAll(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
    await embedded?.stop();
  });

  beforeEach(async () => {
    await dataSource.query(`DELETE FROM document_chunks WHERE client_id = $1`, [CLIENT]);
    await dataSource.query(`DELETE FROM documents WHERE client_id = $1`, [CLIENT]);
  });

  async function ingest(arquivo: string, mimeType: string) {
    const content = fs.readFileSync(path.join(FIXTURES, arquivo));
    const extracted = await extraction.extract({ content, filename: arquivo, mimeType });
    const chunks = chunkPages(extracted.pages, { chunkSize: 1200, overlap: 150 });

    const { document } = await documentsService.registerClientDocument({
      scope: 'client',
      clientId: CLIENT,
      scopePath: SCOPE,
      storagePath: `${SCOPE}/${arquivo}`,
      filename: arquivo,
      sha256: arquivo.padEnd(64, '0').slice(0, 64),
      mimeType,
      sizeBytes: content.length,
    });

    await chunksService.replaceForDocument({
      scope: 'client',
      documentId: document.id,
      clientId: CLIENT,
      scopePath: SCOPE,
      embeddingModel: 'nomic-embed-text',
      embeddingDimensions: 768,
      chunks: chunks.map((chunk) => ({
        chunkIndex: chunk.chunkIndex,
        pageNumber: chunk.pageNumber,
        content: chunk.content,
        embedding: embeddingOf(chunk.content),
      })),
    });

    return { documentId: document.id, extracted, chunks };
  }

  it.each(FORMATOS)('$arquivo é extraído, ingerido e recuperado com procedência', async (formato) => {
    const { documentId, extracted, chunks } = await ingest(formato.arquivo, formato.mimeType);

    expect(extracted.source).toBe(formato.source);
    expect(chunks.length).toBeGreaterThan(0);

    const [trecho] = await chunksService.searchSimilar({
      scope: { kind: 'client', clientId: CLIENT, scopePath: SCOPE },
      embedding: embeddingOf(chunks[0].content),
      embeddingModel: 'nomic-embed-text',
    });

    expect(trecho).toMatchObject({
      documentId,
      filename: formato.arquivo,
      storagePath: `${SCOPE}/${formato.arquivo}`,
      scopePath: SCOPE,
      embeddingModel: 'nomic-embed-text',
    });
    expect(trecho.content).toBe(chunks[0].content);
    expect(trecho.similarity).toBeGreaterThan(0.9);
  }, 60000);

  it.each(FORMATOS)('$arquivo mantém a paginação que o formato realmente tem', async (formato) => {
    const { chunks } = await ingest(formato.arquivo, formato.mimeType);

    const paginas = chunks.map((chunk) => chunk.pageNumber);
    if (formato.paginado) {
      expect(paginas.every((pagina) => typeof pagina === 'number' && pagina >= 1)).toBe(true);
    } else {
      expect(paginas.every((pagina) => pagina === null)).toBe(true);
    }
  }, 60000);

  it('os três formatos convivem no mesmo cliente sem se misturar', async () => {
    for (const formato of FORMATOS) {
      await ingest(formato.arquivo, formato.mimeType);
    }

    const arquivos = await dataSource.query(
      `SELECT DISTINCT d.filename FROM documents d
        JOIN document_chunks c ON c.document_id = d.id
       WHERE d.client_id = $1 ORDER BY d.filename`,
      [CLIENT],
    );

    expect(arquivos.map((linha: { filename: string }) => linha.filename)).toEqual([
      'apresentacao.pptx',
      'legado.doc',
      'legado.xls',
    ]);
  }, 120000);

  it('o PDF atravessa extração, ingestão e recuperação com procedência', async () => {
    const { documentId, extracted, chunks } = await ingest(PDF.arquivo, PDF.mimeType);

    expect(extracted.source).toBe(PDF.source);
    expect(extracted.pages.map((pagina) => pagina.text).join(' '))
      .toContain('ORQUIDEA CROMADA 47');
    expect(chunks.every((chunk) => typeof chunk.pageNumber === 'number')).toBe(true);

    const [trecho] = await chunksService.searchSimilar({
      scope: { kind: 'client', clientId: CLIENT, scopePath: SCOPE },
      embedding: embeddingOf(chunks[0].content),
      embeddingModel: 'nomic-embed-text',
    });

    expect(trecho).toMatchObject({
      documentId,
      filename: PDF.arquivo,
      storagePath: `${SCOPE}/${PDF.arquivo}`,
    });
  }, 60000);

  it('formato legado não suportado falha em vez de entrar vazio no acervo', async () => {
    await expect(extraction.extract({
      content: Buffer.from('conteudo qualquer'),
      filename: 'planilha.numbers',
      mimeType: 'application/x-iwork-numbers-sffnumbers',
    })).rejects.toMatchObject({ name: 'UnsupportedDocumentTypeError' });
  });

  it('arquivo com a extensão certa e conteúdo corrompido falha', async () => {
    await expect(extraction.extract({
      content: Buffer.from('isto nao e um documento do Word'),
      filename: 'quebrado.doc',
      mimeType: 'application/msword',
    })).rejects.toBeInstanceOf(Error);
  });
});
