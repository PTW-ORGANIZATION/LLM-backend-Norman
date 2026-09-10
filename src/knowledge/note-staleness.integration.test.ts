import { DataSource } from 'typeorm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DocumentChunk } from '../documents/document-chunk.entity';
import { DocumentRecord } from '../documents/document.entity';
import { DocumentsService } from '../documents/documents.service';
import { KnowledgeNote, KnowledgeNoteKind } from './knowledge-note.entity';
import { KnowledgeNotesService } from './knowledge-notes.service';
import { startIntegrationPostgres, type EmbeddedPostgres } from '../test/embedded-postgres';
import { KNOWLEDGE_MIGRATIONS } from '../test/knowledge-migrations';

const CLIENT = 'it-stale-acme';
const OTHER_CLIENT = 'it-stale-rival';
const SCOPE = 'Acme/01_Brand';

describe('Invalidação de dossiê contra Postgres real', () => {
  let embedded: EmbeddedPostgres;
  let dataSource: DataSource;
  let notesService: KnowledgeNotesService;
  let documentsService: DocumentsService;

  async function seedDocument(clientId = CLIENT) {
    const { document } = await documentsService.registerClientDocument({
      scope: 'client',
      clientId,
      scopePath: SCOPE,
      storagePath: `${SCOPE}/guia.pdf`,
      filename: 'guia.pdf',
      sha256: 'd'.repeat(64),
    });
    return document.id;
  }

  async function seedDossier(clientId = CLIENT) {
    return notesService.saveClientNote({
      clientId,
      kind: KnowledgeNoteKind.CLIENT_DOSSIER,
      model: 'llama3.1:8b',
      generatorVersion: 3,
      sourceFingerprint: 'f'.repeat(64),
      content: { resumo: 'Rede de clínicas.' },
    });
  }

  beforeAll(async () => {
    embedded = await startIntegrationPostgres({
      entities: [DocumentRecord, DocumentChunk, KnowledgeNote],
      migrations: KNOWLEDGE_MIGRATIONS,
    });
    dataSource = new DataSource(embedded.options);
    await dataSource.initialize();
    await dataSource.runMigrations();
    notesService = new KnowledgeNotesService(dataSource.getRepository(KnowledgeNote));
    documentsService = new DocumentsService(dataSource.getRepository(DocumentRecord));
  }, 120000);

  afterAll(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
    await embedded?.stop();
  });

  beforeEach(async () => {
    const clients = [CLIENT, OTHER_CLIENT];
    await dataSource.query(`DELETE FROM knowledge_notes WHERE client_id = ANY($1)`, [clients]);
    await dataSource.query(`DELETE FROM documents WHERE client_id = ANY($1)`, [clients]);
  });

  it('marca o dossiê do cliente e registra o motivo', async () => {
    await seedDossier();

    const marcadas = await notesService.markClientNotesStale(CLIENT, 'documento removido');

    expect(marcadas).toBe(1);
    const nota = await notesService.findClientNote(CLIENT, KnowledgeNoteKind.CLIENT_DOSSIER);
    expect(nota?.staleSince).toBeInstanceOf(Date);
    expect(nota?.staleReason).toBe('documento removido');
  });

  it('não marca o dossiê de outro cliente', async () => {
    await seedDossier();
    await seedDossier(OTHER_CLIENT);

    await notesService.markClientNotesStale(CLIENT, 'documento removido');

    const outro = await notesService.findClientNote(OTHER_CLIENT, KnowledgeNoteKind.CLIENT_DOSSIER);
    expect(outro?.staleSince).toBeNull();
  });

  it('marcar de novo não sobrescreve a marca original', async () => {
    await seedDossier();
    await notesService.markClientNotesStale(CLIENT, 'primeira remoção');
    const primeira = await notesService.findClientNote(CLIENT, KnowledgeNoteKind.CLIENT_DOSSIER);

    const segunda = await notesService.markClientNotesStale(CLIENT, 'segunda remoção');

    expect(segunda).toBe(0);
    const nota = await notesService.findClientNote(CLIENT, KnowledgeNoteKind.CLIENT_DOSSIER);
    expect(nota?.staleReason).toBe('primeira remoção');
    expect(nota?.staleSince).toEqual(primeira?.staleSince);
  });

  it('a reconsolidação limpa a marca ao gravar a versão nova', async () => {
    await seedDossier();
    await notesService.markClientNotesStale(CLIENT, 'documento removido');

    await notesService.saveClientNote({
      clientId: CLIENT,
      kind: KnowledgeNoteKind.CLIENT_DOSSIER,
      model: 'llama3.1:8b',
      generatorVersion: 3,
      sourceFingerprint: 'a'.repeat(64),
      content: { resumo: 'Rede de clínicas, sem o guia removido.' },
    });

    const nota = await notesService.findClientNote(CLIENT, KnowledgeNoteKind.CLIENT_DOSSIER);
    expect(nota?.staleSince).toBeNull();
    expect(nota?.staleReason).toBeNull();
    expect(nota?.content).toEqual({ resumo: 'Rede de clínicas, sem o guia removido.' });
  });

  it('cliente sem dossiê nenhum não quebra a invalidação', async () => {
    await expect(notesService.markClientNotesStale(CLIENT, 'documento removido')).resolves.toBe(0);
  });

  it('remover o documento leva a nota dele embora', async () => {
    const documentId = await seedDocument();
    await notesService.saveDocumentNote({
      scope: 'client',
      documentId,
      clientId: CLIENT,
      scopePath: SCOPE,
      kind: KnowledgeNoteKind.DOCUMENT_SUMMARY,
      model: 'llama3.1:8b',
      generatorVersion: 2,
      sourceFingerprint: 'd'.repeat(64),
      content: { resumo: 'ORQUIDEA CROMADA 47' },
    });

    await documentsService.forgetPath({ scope: 'client', clientId: CLIENT, storagePath: `${SCOPE}/guia.pdf` });

    const notas = await notesService.listDocumentNoteDetails(CLIENT);
    expect(notas).toEqual([]);
  });
});
