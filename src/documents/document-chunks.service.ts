import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { toSql } from 'pgvector';
import { DocumentChunk } from './document-chunk.entity';

const RAG_TOP_K = 5;

interface SearchSimilarParams {
  userId: string;
  organizationId: string | null;
  projectId: string | null;
  embedding: number[];
}

@Injectable()
export class DocumentChunksService {
  constructor(
    @InjectRepository(DocumentChunk)
    private readonly documentChunksRepository: Repository<DocumentChunk>,
  ) {}

  // Regra crítica de isolamento (seção 4.2 do documento, mesma citada na
  // migration inicial): sempre filtrar por user_id + organization_id +
  // project_id. document_chunks.organization_id é NOT NULL, então um usuário
  // sem organização nunca teria match — curto-circuita antes de consultar.
  //
  // O filtro de project_id é assimétrico DE PROPÓSITO: se a conversa não tem
  // projeto, só retorna chunks sem projeto (gerais); se tem, retorna os do
  // projeto + os gerais. Não "conserte" isso pra "project_id = :projectId" puro.
  async searchSimilar({
    userId,
    organizationId,
    projectId,
    embedding,
  }: SearchSimilarParams): Promise<Array<{ content: string }>> {
    if (!organizationId) {
      return [];
    }

    return this.documentChunksRepository
      .createQueryBuilder('chunk')
      .select('chunk.content', 'content')
      .where('chunk.user_id = :userId', { userId })
      .andWhere('chunk.organization_id = :organizationId', { organizationId })
      .andWhere('(chunk.project_id = :projectId OR chunk.project_id IS NULL)', { projectId })
      // <=> (cosine) para bater com o índice HNSW vector_cosine_ops já criado.
      // O cast ::vector é obrigatório — sem ele o Postgres não resolve o
      // operador contra um parâmetro bind sem tipo.
      .orderBy('chunk.embedding <=> :embedding::vector')
      .setParameter('embedding', toSql(embedding))
      // TODO(rag-ingestao): considerar um threshold mínimo de similaridade
      // quando a ingestão de documentos existir (hoje document_chunks está vazia).
      .limit(RAG_TOP_K)
      .getRawMany<{ content: string }>();
  }
}
