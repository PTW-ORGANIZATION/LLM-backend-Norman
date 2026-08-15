import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn } from 'typeorm';

@Entity('document_chunks')
export class DocumentChunk {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  // Coluna simples (sem relation) — a entity Document ainda não existe
  // (ingestão de documentos é uma tarefa futura separada).
  @Column({ name: 'document_id', type: 'uuid' })
  documentId: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  @Column({ name: 'organization_id', type: 'uuid' })
  organizationId: string;

  @Column({ name: 'project_id', type: 'uuid', nullable: true })
  projectId: string | null;

  @Column({ name: 'chunk_index', type: 'int' })
  chunkIndex: number;

  @Column({ type: 'text' })
  content: string;

  // Tipo nativo do driver Postgres do TypeORM (não usar varchar/text aqui —
  // isso geraria um DROP+ADD destrutivo num futuro migration:generate).
  @Column({ type: 'vector', length: 768 })
  embedding: number[];

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
