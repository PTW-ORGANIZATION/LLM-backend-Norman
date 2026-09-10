import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { DocumentRecord } from '../documents/document.entity';
import {
  CLIENT_SCOPE,
  IngestionScope,
  scopeOwnershipProblem,
  SYSTEM_SCOPE,
} from '../documents/knowledge-scope';
import { DocumentNoteRow } from './client-dossier';
import { KnowledgeNote, KnowledgeNoteKind } from './knowledge-note.entity';

export interface ScopeDocumentStatus {
  storagePath: string;
  filename: string;
  status: string;
  /**
   * Por que a ingestão do documento não terminou, quando ela falhou.
   *
   * Vai junto do estado porque a ficha administrativa do outro lado precisa
   * mostrar a causa: sem ela, um documento que falhou na extração aparecia
   * como "ainda estudando" para sempre.
   */
  failureReason: string | null;
  studied: boolean;
  updatedAt: Date;
}

/** Uma linha da tela de conhecimento do cliente. Nunca carrega embedding. */
export interface ClientDocumentRow {
  documentId: string;
  filename: string;
  scopePath: string;
  storagePath: string;
  mimeType: string | null;
  sizeBytes: string | null;
  sha256: string | null;
  status: string;
  extractionSource: string | null;
  failureReason: string | null;
  chunks: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface DocumentNoteDetail {
  documentId: string;
  kind: string;
  content: Record<string, unknown>;
  model: string;
  generatorVersion: number;
  updatedAt: Date;
}

export interface SaveClientNoteInput {
  clientId: string;
  kind: KnowledgeNoteKind;
  model: string;
  generatorVersion: number;
  sourceFingerprint: string;
  content: Record<string, unknown>;
}

/**
 * A condição de dono de um documento, pelo nível, com os parâmetros dela.
 *
 * `next` é o número do primeiro parâmetro livre depois do dono: o acervo geral
 * não tem cliente e por isso começa em `$1`.
 */
function documentOwner(scope: IngestionScope, clientId: string | null) {
  return scope === SYSTEM_SCOPE
    ? {
        clause: `d.knowledge_scope = 'system' AND d.client_id IS NULL`,
        params: [] as unknown[],
        next: 1,
      }
    : {
        clause: `d.knowledge_scope = 'client' AND d.client_id = $1`,
        params: [clientId] as unknown[],
        next: 2,
      };
}

export interface SaveDocumentNoteInput {
  documentId: string;
  /** O nível do acervo do documento que esta nota descreve. */
  scope: IngestionScope;
  clientId: string | null;
  scopePath: string;
  kind: KnowledgeNoteKind;
  model: string;
  generatorVersion: number;
  sourceFingerprint: string;
  content: Record<string, unknown>;
}

@Injectable()
export class KnowledgeNotesService {
  constructor(
    @InjectRepository(KnowledgeNote)
    private readonly notesRepository: Repository<KnowledgeNote>,
  ) {}

  findDocumentNote(documentId: string, kind: KnowledgeNoteKind): Promise<KnowledgeNote | null> {
    return this.notesRepository.findOne({ where: { documentId, kind } });
  }

  /**
   * A nota de cliente — o dossiê. `document_id` nulo é o que a distingue das
   * notas de documento, e é a condição do índice único que a mantém única.
   */
  findClientNote(clientId: string, kind: KnowledgeNoteKind): Promise<KnowledgeNote | null> {
    return this.notesRepository.findOne({
      where: { knowledgeScope: CLIENT_SCOPE, clientId, kind, documentId: IsNull() },
    });
  }

  /**
   * Todas as notas de documento de um cliente, com o nome do arquivo a que cada
   * uma se refere.
   *
   * O nome vem do `documents` por junção, e não da própria nota, porque renomear
   * arquivo não deve obrigar a reescrever nota nenhuma.
   */
  async listDocumentNotes(clientId: string): Promise<DocumentNoteRow[]> {
    const rows = await this.notesRepository
      .createQueryBuilder('note')
      .innerJoin(DocumentRecord, 'document', 'document.id = note.document_id')
      .select('note.document_id', 'documentId')
      .addSelect('note.kind', 'kind')
      .addSelect('note.scope_path', 'scopePath')
      .addSelect('note.source_fingerprint', 'sourceFingerprint')
      .addSelect('note.content', 'content')
      .addSelect('document.filename', 'filename')
      .where('note.knowledge_scope = :level', { level: CLIENT_SCOPE })
      .andWhere('note.client_id = :clientId', { clientId })
      .andWhere('note.document_id IS NOT NULL')
      .orderBy('document.filename', 'ASC')
      .addOrderBy('note.kind', 'ASC')
      .getRawMany<DocumentNoteRow>();

    return rows;
  }

  /**
   * O estado de ingestão dos arquivos de uma pasta, para a tela do repositório.
   *
   * Compara `scope_path` por igualdade, não por prefixo: a tela mostra uma pasta,
   * e nome de pasta do Norman é cheio de `_`, que é curinga no `LIKE` e traria a
   * pasta irmã junto.
   */
  async listScopeStatus(input: {
    scope?: IngestionScope;
    clientId?: string | null;
    scopePath: string;
    limit?: number;
  }): Promise<ScopeDocumentStatus[]> {
    const scope = input.scope ?? CLIENT_SCOPE;
    // O acervo geral não tem cliente, e por isso a consulta dele tem um
    // parâmetro menos. A numeração é montada junto da lista: o Postgres recusa
    // uma consulta que receba um parâmetro que ela não menciona.
    const dono = documentOwner(scope, input.clientId ?? null);

    return this.notesRepository.manager.query(
      `SELECT d.storage_path AS "storagePath",
              d.filename AS "filename",
              d.status AS "status",
              d.failure_reason AS "failureReason",
              d.updated_at AS "updatedAt",
              EXISTS (
                SELECT 1 FROM knowledge_notes n
                 WHERE n.document_id = d.id AND n.kind = $${dono.next + 1}
              ) AS "studied"
         FROM documents d
        WHERE ${dono.clause} AND d.scope_path = $${dono.next}
        ORDER BY d.filename
        LIMIT $${dono.next + 2}`,
      [
        ...dono.params,
        input.scopePath,
        KnowledgeNoteKind.DOCUMENT_SUMMARY,
        Math.max(1, input.limit ?? 2000),
      ],
    );
  }

  /**
   * Os documentos do acervo de um cliente, com contagem de chunks, origem da
   * extração e motivo da falha.
   *
   * A contagem sai por subconsulta em vez de junção com agregação para que
   * documento sem nenhum chunk continue aparecendo na lista — é justamente o
   * caso que a tela precisa mostrar. `embedding` não é selecionado em lugar
   * nenhum: é vetor grande e não é informação de tela.
   */
  listClientDocuments(clientId: string, limit?: number): Promise<ClientDocumentRow[]> {
    return this.listScopeDocuments({ scope: CLIENT_SCOPE, clientId, limit });
  }

  /** Os documentos do acervo geral do sistema, com a mesma forma de linha. */
  listSystemDocuments(limit?: number): Promise<ClientDocumentRow[]> {
    return this.listScopeDocuments({ scope: SYSTEM_SCOPE, clientId: null, limit });
  }

  private listScopeDocuments(input: {
    scope: IngestionScope;
    clientId: string | null;
    limit?: number;
  }): Promise<ClientDocumentRow[]> {
    const dono = documentOwner(input.scope, input.clientId);

    return this.notesRepository.manager.query(
      `SELECT d.id AS "documentId",
              d.filename AS "filename",
              d.scope_path AS "scopePath",
              d.storage_path AS "storagePath",
              d.mime_type AS "mimeType",
              d.size_bytes AS "sizeBytes",
              d.sha256 AS "sha256",
              d.status AS "status",
              d.extraction_source AS "extractionSource",
              d.failure_reason AS "failureReason",
              d.created_at AS "createdAt",
              d.updated_at AS "updatedAt",
              (SELECT COUNT(*)::int FROM document_chunks c WHERE c.document_id = d.id) AS "chunks"
         FROM documents d
        WHERE ${dono.clause}
        ORDER BY d.scope_path, d.filename
        LIMIT $${dono.next}`,
      [...dono.params, Math.max(1, input.limit ?? 2000)],
    );
  }

  /**
   * As notas de documento de um cliente com a procedência de cada uma.
   *
   * Separada de `listDocumentNotes` de propósito: aquela alimenta a montagem do
   * dossiê e mudar o formato dela mexeria no que o modelo recebe. Esta é só
   * para exibição, e por isso carrega modelo, versão e data.
   */
  listDocumentNoteDetails(clientId: string): Promise<DocumentNoteDetail[]> {
    return this.noteDetails(CLIENT_SCOPE, clientId);
  }

  /** As notas de documento do acervo geral do sistema, com procedência. */
  listSystemNoteDetails(): Promise<DocumentNoteDetail[]> {
    return this.noteDetails(SYSTEM_SCOPE, null);
  }

  private noteDetails(
    scope: IngestionScope,
    clientId: string | null,
  ): Promise<DocumentNoteDetail[]> {
    const query = this.notesRepository
      .createQueryBuilder('note')
      .select('note.document_id', 'documentId')
      .addSelect('note.kind', 'kind')
      .addSelect('note.content', 'content')
      .addSelect('note.model', 'model')
      .addSelect('note.generator_version', 'generatorVersion')
      .addSelect('note.updated_at', 'updatedAt')
      .where('note.knowledge_scope = :level', { level: scope })
      .andWhere('note.document_id IS NOT NULL');

    if (scope === SYSTEM_SCOPE) {
      query.andWhere('note.client_id IS NULL');
    } else {
      query.andWhere('note.client_id = :clientId', { clientId });
    }

    return query.orderBy('note.kind', 'ASC').getRawMany<DocumentNoteDetail>();
  }

  async saveClientNote(input: SaveClientNoteInput): Promise<KnowledgeNote> {
    const existing = await this.findClientNote(input.clientId, input.kind);
    const fresh = { ...input, staleSince: null, staleReason: null };

    return this.notesRepository.save(
      existing
        ? this.notesRepository.merge(existing, fresh)
        : this.notesRepository.create({
            ...fresh,
            knowledgeScope: CLIENT_SCOPE,
            documentId: null,
            scopePath: null,
          }),
    );
  }

  /**
   * Marca as notas de cliente como desatualizadas na mesma chamada em que o
   * documento sai do acervo.
   *
   * A reconsolidação é assíncrona e pode atrasar ou falhar; até ela gravar uma
   * versão nova, o dossiê descreve conteúdo que já não existe e não pode ser
   * servido. A marca vive no banco, não na fila, para que ela valha mesmo com a
   * fila fora do ar.
   */
  async markClientNotesStale(clientId: string, reason: string): Promise<number> {
    const result = await this.notesRepository
      .createQueryBuilder()
      .update(KnowledgeNote)
      .set({ staleSince: () => 'now()', staleReason: reason })
      .where('knowledge_scope = :level', { level: CLIENT_SCOPE })
      .andWhere('client_id = :clientId', { clientId })
      .andWhere('document_id IS NULL')
      .andWhere('stale_since IS NULL')
      .execute();
    return result.affected ?? 0;
  }

  /** Esquece o dossiê de um cliente que ficou sem acervo. */
  async forgetClientNote(clientId: string, kind: KnowledgeNoteKind): Promise<number> {
    const result = await this.notesRepository.delete({
      knowledgeScope: CLIENT_SCOPE,
      clientId,
      kind,
      documentId: IsNull(),
    });
    return result.affected ?? 0;
  }

  /**
   * Grava a nota de um documento, trocando a anterior do mesmo tipo.
   *
   * A identidade é o par documento + tipo, e é o índice único parcial que a
   * garante: um documento tem no máximo um resumo, e regerar substitui em vez de
   * acumular versões que a consulta teria de desempatar.
   */
  async saveDocumentNote(input: SaveDocumentNoteInput): Promise<KnowledgeNote> {
    const problem = scopeOwnershipProblem({ scope: input.scope, clientId: input.clientId });
    if (problem) throw new Error(problem);

    const { scope, ...rest } = input;
    const row = {
      ...rest,
      knowledgeScope: scope,
      clientId: scope === CLIENT_SCOPE ? input.clientId : null,
    };
    const existing = await this.findDocumentNote(input.documentId, input.kind);

    return this.notesRepository.save(
      existing
        ? this.notesRepository.merge(existing, row)
        : this.notesRepository.create(row),
    );
  }
}
