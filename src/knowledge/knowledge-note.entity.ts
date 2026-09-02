import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export enum KnowledgeNoteKind {
  DOCUMENT_SUMMARY = 'document_summary',
  BRAND_GUIDE = 'brand_guide',
}

@Entity('knowledge_notes')
@Index('idx_knowledge_notes_client_scope', ['clientId', 'scopePath'])
export class KnowledgeNote {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  // Nulo na nota de cliente (o dossiê consolidado), preenchido na nota de
  // documento. Os dois índices únicos parciais dependem disso.
  @Column({ name: 'document_id', type: 'uuid', nullable: true })
  documentId: string | null;

  @Column({ name: 'client_id', type: 'varchar', length: 255 })
  clientId: string;

  // Caminho da pasta no repositório do Norman, cru. Não re-sanitize.
  @Column({ name: 'scope_path', type: 'text', nullable: true })
  scopePath: string | null;

  @Column({ type: 'varchar', length: 50 })
  kind: KnowledgeNoteKind;

  // O modelo que produziu esta nota, do jeito que o Ollama o nomeou. Guardado
  // para que trocar de modelo seja detectável sem reler o acervo.
  @Column({ type: 'varchar', length: 255 })
  model: string;

  @Column({ name: 'generator_version', type: 'int' })
  generatorVersion: number;

  // O que a nota descreve: o sha256 do arquivo, na nota de documento.
  @Column({ name: 'source_fingerprint', type: 'varchar', length: 64 })
  sourceFingerprint: string;

  @Column({ type: 'jsonb' })
  content: Record<string, unknown>;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
