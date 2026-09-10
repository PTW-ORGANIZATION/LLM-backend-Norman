import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';

/**
 * Uma revisão de conexão reconhecida por este executor.
 *
 * O contrato de geração carrega `connectionKey` e `connectionRevision`, e sem um
 * registro deste lado a revisão era só um número copiado do corpo: revisão
 * inexistente, antiga ou de outra conexão executava com a configuração vigente
 * e o registro de execução apontava para algo que nunca foi provisionado aqui.
 *
 * O vínculo chave + revisão + modelo + digest é imutável depois de criado.
 * Sincronizar de novo com os mesmos valores é idempotente; sincronizar a mesma
 * revisão com outro modelo é recusado, e não silenciosamente aceito — é
 * exatamente o caso em que a aprovação de um modelo viraria aprovação de outro.
 */
@Entity('connection_revisions')
@Unique('uq_connection_revisions_key_revision', ['connectionKey', 'revision'])
export class ConnectionRevision {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'connection_key', type: 'varchar', length: 64 })
  connectionKey: string;

  @Column({ type: 'int' })
  revision: number;

  @Column({ type: 'varchar', length: 255 })
  model: string;

  /**
   * O identificador da configuração provisionada que esta revisão aprovou.
   *
   * Não carrega URL nem segredo: é um resumo estável do provisionamento, para
   * uma revisão aprovada deixar de valer quando o provisionamento muda.
   */
  @Column({ name: 'config_digest', type: 'varchar', length: 128 })
  configDigest: string;

  @Column({ name: 'is_enabled', type: 'boolean', default: true })
  isEnabled: boolean;

  /**
   * A ativação que esta revisão recebeu, ou nulo.
   *
   * Coluna herdada, mantida para não reescrever o que já foi gravado. A
   * autorização da geração não a consulta mais: um campo só por revisão é
   * sobrescrevível, e uma tentativa posterior apagava o vínculo válido anterior.
   * Quem responde por ativação agora é `connection_activations`, uma linha por
   * identidade confirmada.
   */
  @Column({ name: 'activation_id', type: 'varchar', length: 255, nullable: true })
  activationId: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
