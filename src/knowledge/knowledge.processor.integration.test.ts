import { ConfigService } from '@nestjs/config';
import { Job } from 'bullmq';
import { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DocumentChunk } from '../documents/document-chunk.entity';
import { DocumentRecord } from '../documents/document.entity';
import { DocumentChunksService } from '../documents/document-chunks.service';
import { DocumentsService } from '../documents/documents.service';
import { OllamaService } from '../ollama/ollama.service';
import { KnowledgeNote, KnowledgeNoteKind } from './knowledge-note.entity';
import { KnowledgeNotesService } from './knowledge-notes.service';
import { KnowledgeProcessor } from './knowledge.processor';
import { NoteGenerationService } from './note-generation.service';
import { STUDY_DOCUMENT_JOB, StudyDocumentJobData } from './knowledge-job-data.interface';

// Roda contra um Postgres com pgvector e um Ollama de verdade. Fica de fora da
// suíte padrão porque exige infraestrutura: só liga com KNOWLEDGE_IT_DATABASE
// apontando para um banco DESCARTÁVEL — nunca o banco que serve produção.
const DATABASE = process.env.KNOWLEDGE_IT_DATABASE;
const describeIntegration = DATABASE ? describe : describe.skip;

const CONFIG: Record<string, unknown> = {
  'ollama.host': process.env.OLLAMA_HOST || 'http://127.0.0.1:11434',
  'ollama.model': process.env.OLLAMA_MODEL || 'llama3.1:8b-instruct-q4_0',
  'ollama.embeddingModel': process.env.OLLAMA_EMBEDDING_MODEL || 'nomic-embed-text',
  'knowledge.excerptMaxChars': 12000,
  'knowledge.studyTimeoutMs': 300000,
};

const config = {
  get: (key: string, fallback?: unknown) => CONFIG[key] ?? fallback,
} as unknown as ConfigService;

const CLIENT_ID = 'it-note-acme';
const SCOPE_PATH = 'AcmeCorp/01_Brand_Guide';
const SHA = 'd'.repeat(64);

const PAGES = [
  'Manual de marca da AcmeCorp. O tom de voz é direto, caloroso e sem jargão técnico. ' +
    'Falamos com o cliente final, nunca com o setor.',
  'Paleta: verde AcmeCorp #0F6B3D como cor principal e areia #E8DCC8 como apoio. ' +
    'É proibido usar o logotipo sobre foto sem tarja e proibido distorcer as proporções.',
];

function job(data: StudyDocumentJobData): Job<StudyDocumentJobData> {
  return { name: STUDY_DOCUMENT_JOB, data } as Job<StudyDocumentJobData>;
}

describeIntegration('KnowledgeProcessor contra banco e Ollama reais', () => {
  let dataSource: DataSource;
  let processor: KnowledgeProcessor;
  let notesService: KnowledgeNotesService;
  let documentId: string;

  beforeAll(async () => {
    dataSource = new DataSource({
      type: 'postgres',
      host: process.env.DB_HOST || '127.0.0.1',
      port: parseInt(process.env.DB_PORT || '5432', 10),
      username: process.env.DB_USERNAME,
      password: process.env.DB_PASSWORD,
      database: DATABASE,
      entities: [DocumentRecord, DocumentChunk, KnowledgeNote],
      synchronize: false,
    });
    await dataSource.initialize();

    const documentsService = new DocumentsService(dataSource.getRepository(DocumentRecord));
    const chunksService = new DocumentChunksService(dataSource.getRepository(DocumentChunk));
    notesService = new KnowledgeNotesService(dataSource.getRepository(KnowledgeNote));
    const ollama = new OllamaService(config);

    processor = new KnowledgeProcessor(
      config,
      chunksService,
      notesService,
      new NoteGenerationService(config, ollama),
    );

    const { document } = await documentsService.registerClientDocument({
      clientId: CLIENT_ID,
      scopePath: SCOPE_PATH,
      storagePath: `${SCOPE_PATH}/manual.pdf`,
      filename: 'manual.pdf',
      sha256: SHA,
    });
    documentId = document.id;

    const embeddings = await ollama.embedBatch(PAGES);
    await chunksService.replaceForDocument({
      documentId,
      clientId: CLIENT_ID,
      scopePath: SCOPE_PATH,
      chunks: PAGES.map((content, index) => ({
        chunkIndex: index,
        pageNumber: index + 1,
        content,
        embedding: embeddings[index],
      })),
    });
  }, 180000);

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.query('DELETE FROM documents WHERE client_id = $1', [CLIENT_ID]);
      await dataSource.destroy();
    }
  });

  it('estuda o documento e grava a nota em JSON validado', async () => {
    const result = await processor.process(
      job({
        documentId,
        clientId: CLIENT_ID,
        scopePath: SCOPE_PATH,
        filename: 'manual.pdf',
        sha256: SHA,
      }),
    );

    expect(result.regenerated).toBe(true);

    const note = await notesService.findDocumentNote(
      documentId,
      KnowledgeNoteKind.DOCUMENT_SUMMARY,
    );

    expect(note?.model).toBe(CONFIG['ollama.model']);
    expect(note?.generatorVersion).toBe(1);
    expect(note?.sourceFingerprint).toBe(SHA);
    expect(note?.clientId).toBe(CLIENT_ID);
    expect(note?.scopePath).toBe(SCOPE_PATH);
    expect(typeof note?.content.resumo).toBe('string');
    expect((note?.content.resumo as string).length).toBeGreaterThan(20);
    expect(Array.isArray(note?.content.topicos)).toBe(true);
  }, 300000);

  it('a nota é gravada como jsonb consultável, não como texto', async () => {
    const [row] = await dataSource.query(
      `SELECT content->>'resumo' AS resumo, jsonb_typeof(content->'topicos') AS topicos_tipo
         FROM knowledge_notes WHERE document_id = $1`,
      [documentId],
    );

    expect(typeof row.resumo).toBe('string');
    expect(row.topicos_tipo).toBe('array');
  });

  it('a segunda passada não regera nem duplica a nota', async () => {
    const result = await processor.process(
      job({
        documentId,
        clientId: CLIENT_ID,
        scopePath: SCOPE_PATH,
        filename: 'manual.pdf',
        sha256: SHA,
      }),
    );

    expect(result.regenerated).toBe(false);

    const [{ count }] = await dataSource.query(
      'SELECT count(*)::int AS count FROM knowledge_notes WHERE document_id = $1',
      [documentId],
    );
    expect(count).toBe(1);
  }, 60000);

  it('apagar o documento leva a nota junto', async () => {
    const { document } = await new DocumentsService(
      dataSource.getRepository(DocumentRecord),
    ).registerClientDocument({
      clientId: CLIENT_ID,
      scopePath: SCOPE_PATH,
      storagePath: `${SCOPE_PATH}/efemero.txt`,
      filename: 'efemero.txt',
      sha256: 'e'.repeat(64),
    });

    await notesService.saveDocumentNote({
      documentId: document.id,
      clientId: CLIENT_ID,
      scopePath: SCOPE_PATH,
      kind: KnowledgeNoteKind.DOCUMENT_SUMMARY,
      model: 'qualquer',
      generatorVersion: 1,
      sourceFingerprint: 'e'.repeat(64),
      content: { resumo: 'x' },
    });

    await dataSource.query('DELETE FROM documents WHERE id = $1', [document.id]);

    const [{ count }] = await dataSource.query(
      'SELECT count(*)::int AS count FROM knowledge_notes WHERE document_id = $1',
      [document.id],
    );
    expect(count).toBe(0);
  });
});
