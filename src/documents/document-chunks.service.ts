import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { toSql } from 'pgvector';
import { DocumentChunk } from './document-chunk.entity';
import { scopePathAncestors } from './scope-path';

const RAG_TOP_K = 5;

/**
 * Escopo de pessoa: o conhecimento que o próprio usuário subiu, isolado por
 * organização. É o escopo do chat de hoje.
 *
 * O filtro de `projectId` é assimétrico DE PROPÓSITO: se a conversa não tem
 * projeto, só retorna chunks sem projeto (gerais); se tem, retorna os do projeto
 * mais os gerais. Não "conserte" isso para `project_id = :projectId` puro.
 */
export interface PersonScope {
  kind: 'person';
  userId: string;
  organizationId: string | null;
  projectId: string | null;
}

/**
 * Escopo de cliente: a hierarquia de pastas do repositório do Norman. Recupera
 * dos níveis ancestrais de `scopePath`, nunca dos irmãos, nunca de outro
 * cliente.
 */
export interface ClientScope {
  kind: 'client';
  clientId: string;
  scopePath: string;
}

export type SearchScope = PersonScope | ClientScope;

interface SearchSimilarParams {
  scope: SearchScope;
  embedding: number[];
}

export interface NewClientChunk {
  chunkIndex: number;
  pageNumber: number | null;
  content: string;
  embedding: number[];
}

export interface ReplaceClientChunksParams {
  documentId: string;
  clientId: string;
  scopePath: string;
  chunks: NewClientChunk[];
}

const INSERT_BATCH_SIZE = 200;

@Injectable()
export class DocumentChunksService {
  constructor(
    @InjectRepository(DocumentChunk)
    private readonly documentChunksRepository: Repository<DocumentChunk>,
  ) {}

  /**
   * Os `RAG_TOP_K` chunks mais próximos do embedding dentro do escopo pedido.
   *
   * Os dois escopos são mutuamente exaustivos no banco: linha de escopo de
   * cliente tem `user_id` nulo e linha de escopo de pessoa tem `client_id` nulo,
   * e `NULL` nunca satisfaz `=`. Nenhuma das duas consultas alcança a outra
   * família de linhas, e é o CHECK `chk_document_chunks_scope` que garante que
   * toda linha pertence a exatamente uma delas.
   *
   * Escopo sem o mínimo para ser seguro — pessoa sem organização, cliente sem id
   * ou com caminho vazio ou com `..` — devolve vazio sem consultar, em vez de
   * consultar sem trava.
   */
  async searchSimilar({ scope, embedding }: SearchSimilarParams): Promise<Array<{ content: string }>> {
    const query = this.documentChunksRepository
      .createQueryBuilder('chunk')
      .select('chunk.content', 'content');

    if (scope.kind === 'person') {
      if (!scope.organizationId) {
        return [];
      }

      query
        .where('chunk.user_id = :userId', { userId: scope.userId })
        .andWhere('chunk.organization_id = :organizationId', { organizationId: scope.organizationId })
        .andWhere('(chunk.project_id = :projectId OR chunk.project_id IS NULL)', {
          projectId: scope.projectId,
        });
    } else {
      const ancestors = scopePathAncestors(scope.scopePath);
      if (!scope.clientId || ancestors.length === 0) {
        return [];
      }

      query
        .where('chunk.client_id = :clientId', { clientId: scope.clientId })
        .andWhere('chunk.scope_path IN (:...ancestors)', { ancestors });
    }

    return query
      // <=> (cosine) para bater com o índice HNSW vector_cosine_ops já criado.
      // O cast ::vector é obrigatório — sem ele o Postgres não resolve o
      // operador contra um parâmetro bind sem tipo.
      .orderBy('chunk.embedding <=> :embedding::vector')
      .setParameter('embedding', toSql(embedding))
      // TODO(rag-ingestao): considerar um threshold mínimo de similaridade
      // quando a ingestão de documentos existir.
      .limit(RAG_TOP_K)
      .getRawMany<{ content: string }>();
  }

  /**
   * Troca todos os chunks de um documento pelos novos, numa transação só.
   *
   * Reingerir um arquivo apaga o que havia antes: sem isso, uma segunda versão
   * do mesmo documento conviveria com a primeira e a busca devolveria o texto
   * antigo como se fosse atual.
   *
   * Grava só escopo de cliente — `user_id` e `organization_id` ficam nulos, que
   * é o lado do CHECK `chk_document_chunks_scope` que estas linhas satisfazem.
   */
  async replaceForDocument(params: ReplaceClientChunksParams): Promise<number> {
    return this.documentChunksRepository.manager.transaction(async (manager) => {
      await manager.delete(DocumentChunk, { documentId: params.documentId });

      for (let offset = 0; offset < params.chunks.length; offset += INSERT_BATCH_SIZE) {
        const batch = params.chunks.slice(offset, offset + INSERT_BATCH_SIZE);
        const rows: string[] = [];
        const values: unknown[] = [];

        for (const chunk of batch) {
          const base = values.length;
          rows.push(
            `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}::vector)`,
          );
          values.push(
            params.documentId,
            params.clientId,
            params.scopePath,
            chunk.chunkIndex,
            chunk.pageNumber,
            chunk.content,
            toSql(chunk.embedding),
          );
        }

        await manager.query(
          `INSERT INTO document_chunks
             (document_id, client_id, scope_path, chunk_index, page_number, content, embedding)
           VALUES ${rows.join(', ')}`,
          values,
        );
      }

      return params.chunks.length;
    });
  }
}
