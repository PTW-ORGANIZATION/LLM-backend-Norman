import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

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
export class DocumentRecord {
  @PrimaryGeneratedColumn('uuid')
  id: string;

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

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
