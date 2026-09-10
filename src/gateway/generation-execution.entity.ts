import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Uma tentativa de geração, como ela realmente aconteceu.
 *
 * Uma linha por tentativa, não por operação: quando o fallback entra, as duas
 * tentativas ficam registradas com a mesma correlação, e `fallback_of` diz de
 * qual conexão a segunda é alternativa. Sem isso não haveria como saber que
 * dados foram para outro fornecedor.
 *
 * `evidence` guarda identificadores e números dos trechos usados. Prompt,
 * documento e transcrição não são gravados aqui.
 */
@Entity('generation_executions')
@Index('idx_generation_executions_correlation', ['correlationId'])
@Index('idx_generation_executions_client', ['clientId', 'createdAt'])
export class GenerationExecution {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'correlation_id', type: 'varchar', length: 64 })
  correlationId: string;

  @Column({ type: 'varchar', length: 64 })
  feature: string;

  @Column({ name: 'client_id', type: 'varchar', length: 255, nullable: true })
  clientId: string | null;

  @Column({ name: 'scope_path', type: 'text', nullable: true })
  scopePath: string | null;

  @Column({ name: 'actor_user_id', type: 'varchar', length: 255 })
  actorUserId: string;

  @Column({ name: 'activation_id', type: 'varchar', length: 255 })
  activationId: string;

  @Column({ name: 'connection_key', type: 'varchar', length: 64 })
  connectionKey: string;

  @Column({ name: 'connection_revision', type: 'int' })
  connectionRevision: number;

  @Column({ type: 'varchar', length: 255 })
  model: string;

  @Column({ type: 'int' })
  attempt: number;

  @Column({ name: 'fallback_of', type: 'varchar', length: 64, nullable: true })
  fallbackOf: string | null;

  @Column({ type: 'varchar', length: 32 })
  status: string;

  @Column({ name: 'failure_kind', type: 'varchar', length: 32, nullable: true })
  failureKind: string | null;

  @Column({ name: 'failure_reason', type: 'text', nullable: true })
  failureReason: string | null;

  @Column({ name: 'duration_ms', type: 'int' })
  durationMs: number;

  @Column({ name: 'prompt_tokens', type: 'int', nullable: true })
  promptTokens: number | null;

  @Column({ name: 'completion_tokens', type: 'int', nullable: true })
  completionTokens: number | null;

  @Column({ type: 'jsonb', nullable: true })
  evidence: Record<string, unknown> | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
