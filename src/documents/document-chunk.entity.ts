import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from 'typeorm';

@Entity('document_chunks')
@Index('idx_document_chunks_client_scope', ['clientId', 'scopePath'])
export class DocumentChunk {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  // Coluna simples (sem relation), como no resto do schema.
  @Column({ name: 'document_id', type: 'uuid' })
  documentId: string;

  // Escopo de pessoa. Nulo nas linhas de escopo de cliente — o CHECK do banco
  // exige um dos dois pares preenchido.
  @Column({ name: 'user_id', type: 'uuid', nullable: true })
  userId: string | null;

  @Column({ name: 'organization_id', type: 'uuid', nullable: true })
  organizationId: string | null;

  @Column({ name: 'project_id', type: 'uuid', nullable: true })
  projectId: string | null;

  // Escopo de cliente: o dono da pasta e o caminho dela, cru, do jeito que o
  // Norman gravou.
  @Column({ name: 'client_id', type: 'varchar', length: 255, nullable: true })
  clientId: string | null;

  @Column({ name: 'scope_path', type: 'text', nullable: true })
  scopePath: string | null;

  @Column({ name: 'chunk_index', type: 'int' })
  chunkIndex: number;

  @Column({ name: 'page_number', type: 'int', nullable: true })
  pageNumber: number | null;

  @Column({ type: 'text' })
  content: string;

  // Tipo nativo do driver Postgres do TypeORM (não usar varchar/text aqui —
  // isso geraria um DROP+ADD destrutivo num futuro migration:generate).
  @Column({ type: 'vector', length: 768 })
  embedding: number[];

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
