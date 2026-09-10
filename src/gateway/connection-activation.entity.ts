import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, Unique } from 'typeorm';

/**
 * Uma ativação que este executor reconheceu, vinculada à revisão exata dela.
 *
 * Existe como linha própria, e não como um campo da revisão, porque um campo é
 * sobrescrevível: a segunda tentativa de ativação gravava a identidade nova por
 * cima da anterior e, se ela falhasse no meio, a ativação que estava valendo
 * deixava de resolver — a geração passava a ser recusada com a configuração que
 * o administrador nunca mudou.
 *
 * `activationId` é único: a mesma identidade nunca vale para duas revisões, e
 * confirmar de novo a mesma tupla é idempotente em vez de criar outra linha. O
 * vínculo é imutável depois de criado, e vínculos anteriores continuam
 * existindo — é o que permite descobrir, numa repetição depois de timeout, que
 * a confirmação já havia acontecido.
 *
 * Não guarda URL, credencial nem corpo de prompt: só a identidade da ativação, a
 * chave lógica, o número da revisão, o modelo aprovado e o digest do
 * provisionamento sobre o qual a confirmação valeu.
 */
@Entity('connection_activations')
@Unique('uq_connection_activations_activation', ['activationId'])
@Unique('uq_connection_activations_identity', ['activationId', 'connectionKey', 'revision'])
@Index('idx_connection_activations_revision', ['connectionKey', 'revision'])
export class ConnectionActivation {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'activation_id', type: 'varchar', length: 255 })
  activationId: string;

  @Column({ name: 'connection_key', type: 'varchar', length: 64 })
  connectionKey: string;

  @Column({ type: 'int' })
  revision: number;

  @Column({ type: 'varchar', length: 255 })
  model: string;

  @Column({ name: 'config_digest', type: 'varchar', length: 128 })
  configDigest: string;

  @CreateDateColumn({ name: 'confirmed_at', type: 'timestamptz' })
  confirmedAt: Date;
}
