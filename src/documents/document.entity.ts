import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';
import { KnowledgeScopeKind } from './knowledge-scope';

export enum DocumentStatus {
  PENDING = 'pending',
  PROCESSING = 'processing',
  READY = 'ready',
  FAILED = 'failed',
}

// A tabela existe desde a migração inicial; esta entity é o mapeamento dela.
// Sem relations modeladas — user_id, organization_id e project_id são colunas
// simples, como em ai_jobs e conversation.projectId.
//
// Dois escopos convivem, e o CHECK do banco exige um deles: escopo de pessoa
// (userId + organizationId) ou escopo de cliente (clientId + scopePath), que é
// o que a ingestão vinda do Norman preenche.
@Entity('documents')
@Index('idx_documents_client_scope', ['clientId', 'scopePath'])
@Index('idx_documents_scope_level', ['knowledgeScope', 'scopePath'])
export class DocumentRecord {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /**
   * O nível do acervo a que este documento pertence.
   *
   * Coluna, e não dedução: `system` é o conhecimento geral do Norman e não tem
   * `client_id`, então tratar a ausência dele como "compartilhe com todos"
   * faria uma linha malformada virar acervo público. O CHECK
   * `chk_documents_scope` exige o dono que cada nível requer.
   */
  @Column({ name: 'knowledge_scope', type: 'varchar', length: 16 })
  knowledgeScope: KnowledgeScopeKind;

  @Column({ name: 'user_id', type: 'uuid', nullable: true })
  userId: string | null;

  @Column({ name: 'organization_id', type: 'uuid', nullable: true })
  organizationId: string | null;

  @Column({ name: 'project_id', type: 'uuid', nullable: true })
  projectId: string | null;

  @Column({ name: 'client_id', type: 'varchar', length: 255, nullable: true })
  clientId: string | null;

  // Caminho da pasta no repositório do Norman, cru, do jeito que foi gravado.
  // Não re-sanitize: `sanitizePathSegment` do Norman não é idempotente.
  @Column({ name: 'scope_path', type: 'text', nullable: true })
  scopePath: string | null;

  @Column({ type: 'varchar', length: 500 })
  filename: string;

  @Column({ name: 'storage_path', type: 'varchar', length: 1000 })
  storagePath: string;

  @Column({ type: 'varchar', length: 64, nullable: true })
  sha256: string | null;

  @Column({ name: 'mime_type', type: 'varchar', length: 255, nullable: true })
  mimeType: string | null;

  @Column({ name: 'size_bytes', type: 'bigint', nullable: true })
  sizeBytes: string | null;

  @Column({ type: 'varchar', length: 50, default: DocumentStatus.PENDING })
  status: DocumentStatus;

  // Qual extrator leu o arquivo. Nulo em documento ingerido antes da coluna
  // existir, que não é a mesma coisa que documento sem texto.
  @Column({ name: 'extraction_source', type: 'varchar', length: 50, nullable: true })
  extractionSource: string | null;

  // Motivo da última falha de ingestão, para a tela dizer o que fazer com o
  // arquivo. Nulo quando o documento nunca falhou ou já foi lido com sucesso.
  @Column({ name: 'failure_reason', type: 'text', nullable: true })
  failureReason: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
