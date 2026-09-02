import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { DocumentRecord } from '../documents/document.entity';
import { DocumentNoteRow } from './client-dossier';
import { KnowledgeNote, KnowledgeNoteKind } from './knowledge-note.entity';

export interface SaveClientNoteInput {
  clientId: string;
  kind: KnowledgeNoteKind;
  model: string;
  generatorVersion: number;
  sourceFingerprint: string;
  content: Record<string, unknown>;
}

export interface SaveDocumentNoteInput {
  documentId: string;
  clientId: string;
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
    return this.notesRepository.findOne({ where: { clientId, kind, documentId: IsNull() } });
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
      .where('note.client_id = :clientId', { clientId })
      .andWhere('note.document_id IS NOT NULL')
      .orderBy('document.filename', 'ASC')
      .addOrderBy('note.kind', 'ASC')
      .getRawMany<DocumentNoteRow>();

    return rows;
  }

  async saveClientNote(input: SaveClientNoteInput): Promise<KnowledgeNote> {
    const existing = await this.findClientNote(input.clientId, input.kind);

    return this.notesRepository.save(
      existing
        ? this.notesRepository.merge(existing, input)
        : this.notesRepository.create({ ...input, documentId: null, scopePath: null }),
    );
  }

  /** Esquece o dossiê de um cliente que ficou sem acervo. */
  async forgetClientNote(clientId: string, kind: KnowledgeNoteKind): Promise<number> {
    const result = await this.notesRepository.delete({
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
    const existing = await this.findDocumentNote(input.documentId, input.kind);

    return this.notesRepository.save(
      existing
        ? this.notesRepository.merge(existing, input)
        : this.notesRepository.create(input),
    );
  }
}
