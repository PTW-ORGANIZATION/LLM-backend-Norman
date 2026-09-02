import { ConfigService } from '@nestjs/config';
import { Job, Queue } from 'bullmq';
import { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DocumentChunk } from '../documents/document-chunk.entity';
import { DocumentRecord, DocumentStatus } from '../documents/document.entity';
import { DocumentChunksService } from '../documents/document-chunks.service';
import { DocumentsService } from '../documents/documents.service';
import { OllamaService } from '../ollama/ollama.service';
import { OllamaVisionService } from '../ollama/ollama-vision.service';
import { TextExtractionService } from './extraction/text-extraction.service';
import { IngestionProcessor } from './ingestion.processor';
import { DocumentContent, DocumentContentPort } from './document-content.port';
import { IngestionJobData } from './ingestion-job-data.interface';

// Roda contra um Postgres com pgvector e um Ollama de verdade. Fica de fora da
// suíte padrão porque exige infraestrutura: só liga com INGESTION_IT_DATABASE
// apontando para um banco DESCARTÁVEL — nunca o banco que serve produção.
const DATABASE = process.env.INGESTION_IT_DATABASE;
const describeIntegration = DATABASE ? describe : describe.skip;

const CONFIG: Record<string, unknown> = {
  'ollama.host': process.env.OLLAMA_HOST || 'http://127.0.0.1:11434',
  'ollama.embeddingModel': process.env.OLLAMA_EMBEDDING_MODEL || 'nomic-embed-text',
  'ollama.visionModel': process.env.OLLAMA_VISION_MODEL || 'minicpm-v',
  'ingestion.chunkSize': 1200,
  'ingestion.chunkOverlap': 150,
  'ingestion.embedBatchSize': 16,
  'queue.ingestionConcurrency': 1,
};

const config = {
  get: (key: string, fallback?: unknown) => CONFIG[key] ?? fallback,
} as unknown as ConfigService;

const SCOPE_PATH = 'AcmeCorp/Campanhas/Verao2026';

// A fila de estudo não faz parte do que este teste verifica: o que importa aqui
// é o documento virar chunks consultáveis. O dublê registra o que foi
// enfileirado para que o teste possa afirmar que a ingestão chamou a próxima
// etapa sem depender de um Redis.
function stubKnowledgeQueue() {
  const added: Array<{ name: string; data: unknown }> = [];
  return {
    added,
    queue: {
      add: async (name: string, data: unknown) => {
        added.push({ name, data });
        return { id: 'stub' };
      },
    } as unknown as Queue,
  };
}

class StubContentPort extends DocumentContentPort {
  constructor(private readonly files: Record<string, DocumentContent>) {
    super();
  }

  async fetch(request: { storagePath: string }): Promise<DocumentContent> {
    const file = this.files[request.storagePath];
    if (!file) throw new Error(`sem arquivo de teste para ${request.storagePath}`);
    return file;
  }
}

async function buildXlsx(): Promise<Buffer> {
  const ExcelJS = await import('exceljs');
  const workbook = new ExcelJS.Workbook();
  const midia = workbook.addWorksheet('Midia');
  midia.addRow(['Canal', 'Verba']);
  midia.addRow(['Instagram', 15000]);
  const cronograma = workbook.addWorksheet('Cronograma');
  cronograma.addRow(['Etapa', 'Prazo']);
  cronograma.addRow(['Entrega final da campanha de verao', '2026-10-01']);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

describeIntegration('IngestionProcessor contra banco e Ollama reais', () => {
  let dataSource: DataSource;
  let processor: IngestionProcessor;
  let documentsService: DocumentsService;
  let chunksService: DocumentChunksService;
  let acmeDocumentId: string;
  let rivalDocumentId: string;
  const knowledgeQueue = stubKnowledgeQueue();

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

    const content = new StubContentPort({
      'AcmeCorp/Campanhas/Verao2026/plano.xlsx': {
        content: await buildXlsx(),
        filename: 'plano.xlsx',
        mimeType: null,
      },
      'AcmeCorp/Campanhas/Verao2026/segredo.md': {
        content: Buffer.from('Estrategia confidencial da Rival para o verao', 'utf8'),
        filename: 'segredo.md',
        mimeType: null,
      },
    });

    processor = new IngestionProcessor(
      config,
      documentsService,
      chunksService,
      new TextExtractionService(config, new OllamaVisionService(config)),
      new OllamaService(config),
      content,
      knowledgeQueue.queue,
    );

    const acme = await documentsService.registerClientDocument({
      clientId: 'it-acme',
      scopePath: SCOPE_PATH,
      storagePath: 'AcmeCorp/Campanhas/Verao2026/plano.xlsx',
      filename: 'plano.xlsx',
      sha256: 'a'.repeat(64),
    });
    acmeDocumentId = acme.document.id;

    const rival = await documentsService.registerClientDocument({
      clientId: 'it-rival',
      scopePath: SCOPE_PATH,
      storagePath: 'AcmeCorp/Campanhas/Verao2026/segredo.md',
      filename: 'segredo.md',
      sha256: 'b'.repeat(64),
    });
    rivalDocumentId = rival.document.id;
  }, 120000);

  afterAll(async () => {
    if (!dataSource?.isInitialized) return;
    await dataSource.query(`DELETE FROM document_chunks WHERE client_id IN ('it-acme','it-rival')`);
    await dataSource.query(`DELETE FROM documents WHERE client_id IN ('it-acme','it-rival')`);
    await dataSource.destroy();
  });

  function job(data: IngestionJobData) {
    return { data } as unknown as Job<IngestionJobData>;
  }

  it('transforma o documento entregue em chunks consultáveis', async () => {
    const result = await processor.process(
      job({
        documentId: acmeDocumentId,
        clientId: 'it-acme',
        scopePath: SCOPE_PATH,
        storagePath: 'AcmeCorp/Campanhas/Verao2026/plano.xlsx',
        filename: 'plano.xlsx',
        sha256: 'a'.repeat(64),
      }),
    );

    expect(result.chunks).toBeGreaterThan(0);
    expect(result.source).toBe('xlsx');

    const document = await documentsService.findById(acmeDocumentId);
    expect(document?.status).toBe(DocumentStatus.READY);
  }, 180000);

  it('enfileira o estudo do documento depois de vetorizá-lo', () => {
    expect(knowledgeQueue.added).toContainEqual({
      name: 'study-document',
      data: {
        documentId: acmeDocumentId,
        clientId: 'it-acme',
        scopePath: SCOPE_PATH,
        filename: 'plano.xlsx',
        sha256: 'a'.repeat(64),
      },
    });
  });

  it('grava o número da página junto do chunk', async () => {
    const rows = await dataSource.query(
      `SELECT DISTINCT page_number FROM document_chunks WHERE document_id = $1 ORDER BY page_number`,
      [acmeDocumentId],
    );
    expect(rows.map((row: { page_number: number }) => row.page_number)).toEqual([1, 2]);
  });

  it('grava escopo de cliente e deixa o escopo de pessoa nulo', async () => {
    const [row] = await dataSource.query(
      `SELECT client_id, scope_path, user_id, organization_id FROM document_chunks WHERE document_id = $1 LIMIT 1`,
      [acmeDocumentId],
    );
    expect(row.client_id).toBe('it-acme');
    expect(row.scope_path).toBe(SCOPE_PATH);
    expect(row.user_id).toBeNull();
    expect(row.organization_id).toBeNull();
  });

  it('recupera o próprio conteúdo pela busca vetorial', async () => {
    const ollama = new OllamaService(config);
    const embedding = await ollama.embed('qual a verba de instagram do plano de midia');
    const found = await chunksService.searchSimilar({
      scope: { kind: 'client', clientId: 'it-acme', scopePath: SCOPE_PATH },
      embedding,
    });

    expect(found.length).toBeGreaterThan(0);
    expect(found.some((row) => row.content.includes('Instagram'))).toBe(true);
  }, 60000);

  it('consulta no escopo de outro cliente volta vazia', async () => {
    await processor.process(
      job({
        documentId: rivalDocumentId,
        clientId: 'it-rival',
        scopePath: SCOPE_PATH,
        storagePath: 'AcmeCorp/Campanhas/Verao2026/segredo.md',
        filename: 'segredo.md',
        sha256: 'b'.repeat(64),
      }),
    );

    const ollama = new OllamaService(config);
    const embedding = await ollama.embed('estrategia confidencial da Rival');

    const asAcme = await chunksService.searchSimilar({
      scope: { kind: 'client', clientId: 'it-acme', scopePath: SCOPE_PATH },
      embedding,
    });
    expect(asAcme.every((row) => !row.content.includes('confidencial da Rival'))).toBe(true);

    const asStranger = await chunksService.searchSimilar({
      scope: { kind: 'client', clientId: 'it-desconhecido', scopePath: SCOPE_PATH },
      embedding,
    });
    expect(asStranger).toEqual([]);
  }, 180000);

  it('arquivo sem texto vira failed, não sucesso vazio', async () => {
    const vazio = await documentsService.registerClientDocument({
      clientId: 'it-acme',
      scopePath: SCOPE_PATH,
      storagePath: 'AcmeCorp/Campanhas/Verao2026/vazio.txt',
      filename: 'vazio.txt',
      sha256: 'c'.repeat(64),
    });

    const emptyProcessor = new IngestionProcessor(
      config,
      documentsService,
      chunksService,
      new TextExtractionService(config, new OllamaVisionService(config)),
      new OllamaService(config),
      new StubContentPort({
        'AcmeCorp/Campanhas/Verao2026/vazio.txt': {
          content: Buffer.from('   \n  ', 'utf8'),
          filename: 'vazio.txt',
          mimeType: null,
        },
      }),
      stubKnowledgeQueue().queue,
    );

    await expect(
      emptyProcessor.process(
        job({
          documentId: vazio.document.id,
          clientId: 'it-acme',
          scopePath: SCOPE_PATH,
          storagePath: 'AcmeCorp/Campanhas/Verao2026/vazio.txt',
          filename: 'vazio.txt',
          sha256: 'c'.repeat(64),
        }),
      ),
    ).rejects.toThrow();

    const document = await documentsService.findById(vazio.document.id);
    expect(document?.status).toBe(DocumentStatus.FAILED);
  }, 60000);
});
