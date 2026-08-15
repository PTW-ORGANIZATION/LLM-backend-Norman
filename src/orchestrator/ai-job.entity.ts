import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn } from 'typeorm';

export enum AiJobStatus {
  QUEUED = 'queued',
  PROCESSING = 'processing',
  COMPLETED = 'completed',
  FAILED = 'failed',
}

// Auditoria da fila de inferência. Sem relations modeladas (mesma lacuna já
// aceita em conversation.projectId) — user_id/conversation_id são colunas
// simples aqui.
@Entity('ai_jobs')
export class AiJob {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  @Column({ name: 'conversation_id', type: 'uuid', nullable: true })
  conversationId: string | null;

  @Column({ type: 'varchar', length: 50, default: AiJobStatus.QUEUED })
  status: AiJobStatus;

  @Column({ name: 'prompt_tokens', type: 'int', nullable: true })
  promptTokens: number | null;

  @Column({ name: 'completion_tokens', type: 'int', nullable: true })
  completionTokens: number | null;

  @Column({ name: 'latency_ms', type: 'int', nullable: true })
  latencyMs: number | null;

  @Column({ type: 'text', nullable: true })
  error: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @Column({ name: 'finished_at', type: 'timestamptz', nullable: true })
  finishedAt: Date | null;
}
