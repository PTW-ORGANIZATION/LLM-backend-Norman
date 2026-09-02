import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { KnowledgeNote, KnowledgeNoteKind } from './knowledge-note.entity';

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
