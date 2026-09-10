import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { KnowledgeScopeKind } from './knowledge-scope';

export enum RevocationKind {
  PATH = 'path',
  PREFIX = 'prefix',
}

/**
 * A lápide de um caminho que saiu do acervo.
 *
 * Ela é a exclusão lógica, e sobrevive à remoção física: enquanto estiver
 * vigente, nenhuma ingestão automática recria a fonte e nenhuma busca alcança o
 * que derivava dela. Sem isso, o resync seguinte do repositório reindexaria um
 * arquivo que alguém acabou de tirar de circulação.
 *
 * A identidade é o trio cliente + tipo + caminho, com índice único: revogar
 * duas vezes o mesmo alvo é a mesma revogação, e não duas.
 */
@Entity('knowledge_revocations')
@Index('idx_knowledge_revocations_client', ['clientId', 'revokedAt'])
export class KnowledgeRevocation {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /**
   * O nível do acervo que esta lápide alcança.
   *
   * A identidade da lápide muda com ele: no acervo de cliente é cliente + tipo
   * + caminho, e no acervo geral é tipo + caminho, porque não há cliente para
   * compor a chave. São dois índices únicos parciais, um por nível.
   */
  @Column({ name: 'knowledge_scope', type: 'varchar', length: 16 })
  knowledgeScope: KnowledgeScopeKind;

  // Nulo na lápide do acervo geral do sistema.
  @Column({ name: 'client_id', type: 'varchar', length: 255, nullable: true })
  clientId: string | null;

  @Column({ type: 'varchar', length: 16 })
  kind: RevocationKind;

  // Caminho cru, do jeito que foi gravado. `path` é o arquivo quando o tipo é
  // `path`, e a pasta quando é `prefix` — nesse caso alcança tudo abaixo dela.
  @Column({ type: 'text' })
  path: string;

  @Column({ type: 'text', nullable: true })
  reason: string | null;

  @Column({ name: 'revoked_at', type: 'timestamptz' })
  revokedAt: Date;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
