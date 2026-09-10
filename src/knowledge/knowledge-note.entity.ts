import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { KnowledgeScopeKind } from '../documents/knowledge-scope';

export enum KnowledgeNoteKind {
  DOCUMENT_SUMMARY = 'document_summary',
  BRAND_GUIDE = 'brand_guide',
  CLIENT_DOSSIER = 'client_dossier',
}

@Entity('knowledge_notes')
@Index('idx_knowledge_notes_client_scope', ['clientId', 'scopePath'])
@Index('idx_knowledge_notes_scope_level', ['knowledgeScope', 'scopePath'])
export class KnowledgeNote {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /**
   * O nível do acervo que esta nota descreve.
   *
   * `system` é nota de documento do acervo geral, e nela `client_id` é nulo —
   * o CHECK `chk_knowledge_notes_owner` exige exatamente isso.
   */
  @Column({ name: 'knowledge_scope', type: 'varchar', length: 16 })
  knowledgeScope: KnowledgeScopeKind;

  // Nulo na nota de cliente (o dossiê consolidado), preenchido na nota de
  // documento. Os dois índices únicos parciais dependem disso.
  @Column({ name: 'document_id', type: 'uuid', nullable: true })
  documentId: string | null;

  // Nulo nas notas do acervo geral do sistema, que não tem dono cliente.
  @Column({ name: 'client_id', type: 'varchar', length: 255, nullable: true })
  clientId: string | null;

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

  // Marcado quando um documento sai do acervo: a nota descreve conteúdo que já
  // não existe, e por isso deixa de ser servida até a reconsolidação gravar uma
  // versão nova.
  @Column({ name: 'stale_since', type: 'timestamptz', nullable: true })
  staleSince: Date | null;

  @Column({ name: 'stale_reason', type: 'text', nullable: true })
  staleReason: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
