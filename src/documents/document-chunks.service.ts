import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, SelectQueryBuilder } from 'typeorm';
import { toSql } from 'pgvector';
import { DocumentChunk } from './document-chunk.entity';
import { DocumentRecord } from './document.entity';
import {
  CLIENT_SCOPE,
  IngestionScope,
  scopeOwnershipProblem,
  SYSTEM_SCOPE,
} from './knowledge-scope';
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
 *
 * `scopePath` ausente é a consulta ao cliente inteiro, e ela não passa por
 * caminho nenhum: a trava é o `clientId`. Antes ela mandava uma raiz presumida
 * pela identidade do cliente, e cliente com espaço, `&`, acento ou underscore
 * tinha chunks gravados sob outra grafia — a consulta batia numa pasta que não
 * era de ninguém e devolvia acervo vazio em silêncio.
 */
export interface ClientScope {
  kind: 'client';
  clientId: string;
  scopePath?: string;
  includeDescendants?: boolean;
  /**
   * Pastas do cliente que a busca não alcança, com tudo abaixo delas.
   *
   * Existe para o material que está no repositório do cliente mas não é
   * conhecimento oficial dele — anexo de projeto, por exemplo. Ele continua
   * acessível quando a conversa é daquele projeto, e fica fora da consulta ao
   * cliente inteiro até ser promovido pela regra de aprovação.
   */
  excludeScopePaths?: string[];
}

/**
 * Escopo geral do sistema: o conhecimento do Norman que não tem dono cliente.
 *
 * A trava é o discriminador persistido `knowledge_scope = 'system'`, e nada
 * mais. Não é "consulta sem filtro de cliente" e não é uma pasta com nome
 * combinado: linha malformada, sem `client_id` por acidente, é recusada pelo
 * CHECK antes de existir, e por isso a ausência de cliente nunca vira acervo
 * compartilhado.
 *
 * Ele é consultado **ao lado** do acervo do cliente numa geração vinculada, em
 * duas consultas separadas — nunca numa união solta, que esconderia qual dos
 * dois filtros deixou de ser aplicado.
 */
export interface SystemScope {
  kind: 'system';
  /**
   * Pastas do acervo geral que a busca não alcança, com tudo abaixo delas.
   *
   * Mesmo mecanismo do acervo de cliente, para material geral que ainda não é
   * oficial.
   */
  excludeScopePaths?: string[];
}

export type SearchScope = PersonScope | ClientScope | SystemScope;

interface SearchSimilarParams {
  scope: SearchScope;
  embedding: number[];
  embeddingModel?: string | null;
}

/**
 * Um trecho recuperado com a procedência dele.
 *
 * `distance` é a distância de cosseno que o índice devolveu, e `similarity` é o
 * complemento dela — quem decide se há evidência suficiente precisa do número,
 * não só do texto. `pageNumber` é nulo nos formatos que não têm paginação: o
 * extrator não inventa página, e nada aqui completa o campo.
 */
export interface RetrievedChunk {
  /**
   * De qual camada este trecho veio.
   *
   * Vai junto do conteúdo porque a citação e a auditoria precisam distinguir
   * regra geral do sistema de regra do próprio cliente: sem isso, quem lê a
   * resposta não sabe se o que foi afirmado vale para todos ou só para aquele
   * cliente.
   */
  knowledgeScope: IngestionScope;
  content: string;
  documentId: string;
  filename: string | null;
  storagePath: string | null;
  scopePath: string | null;
  chunkIndex: number;
  pageNumber: number | null;
  embeddingModel: string | null;
  distance: number;
  similarity: number;
}

export interface NewClientChunk {
  chunkIndex: number;
  pageNumber: number | null;
  content: string;
  embedding: number[];
}

export interface ReplaceClientChunksParams {
  documentId: string;
  scope: IngestionScope;
  clientId: string | null;
  scopePath: string;
  embeddingModel: string;
  embeddingDimensions: number;
  chunks: NewClientChunk[];
}

const INSERT_BATCH_SIZE = 200;

interface RawRetrievedChunk {
  knowledgeScope: string;
  content: string;
  documentId: string;
  filename: string | null;
  storagePath: string | null;
  scopePath: string | null;
  chunkIndex: number | string;
  pageNumber: number | string | null;
  embeddingModel: string | null;
  distance: number | string;
}

/**
 * As pastas excluídas, já normalizadas.
 *
 * Caminho com `..` ou vazio é descartado. Quando a consulta parte de uma pasta,
 * exclusão de fora dela também é descartada — excluir o que já estava fora não
 * muda nada, e aceitá-la cru abriria a porta para um caminho arbitrário virar
 * filtro. Na consulta ao cliente inteiro não há raiz única para comparar, e as
 * exclusões valem como estão: o cliente tem mais de uma grafia legítima da
 * própria pasta, e excluir todas é o lado seguro.
 */
function excludedRootsOf(scope: ClientScope | SystemScope): string[] {
  const ancestors = scopePathAncestors('scopePath' in scope ? scope.scopePath : undefined);
  const root = ancestors[ancestors.length - 1];
  const normalized = (scope.excludeScopePaths ?? [])
    .map((path) => scopePathAncestors(path))
    .filter((levels) => levels.length > 0)
    .map((levels) => levels[levels.length - 1])
    .filter((path) => !root || path === root || path.startsWith(`${root}/`));
  return [...new Set(normalized)];
}

function toRetrievedChunk(row: RawRetrievedChunk): RetrievedChunk {
  const distance = Number(row.distance);
  return {
    knowledgeScope: row.knowledgeScope === SYSTEM_SCOPE ? SYSTEM_SCOPE : CLIENT_SCOPE,
    content: row.content,
    documentId: row.documentId,
    filename: row.filename ?? null,
    storagePath: row.storagePath ?? null,
    scopePath: row.scopePath ?? null,
    chunkIndex: Number(row.chunkIndex),
    pageNumber: row.pageNumber === null || row.pageNumber === undefined ? null : Number(row.pageNumber),
    embeddingModel: row.embeddingModel ?? null,
    distance: Number.isFinite(distance) ? distance : Number.NaN,
    similarity: Number.isFinite(distance) ? 1 - distance : Number.NaN,
  };
}

@Injectable()
export class DocumentChunksService {
  constructor(
    @InjectRepository(DocumentChunk)
    private readonly documentChunksRepository: Repository<DocumentChunk>,
  ) {}

  /**
   * Os `RAG_TOP_K` chunks mais próximos do embedding dentro do escopo pedido.
   *
   * Os três níveis são mutuamente exclusivos no banco, e a exclusão é imposta
   * pela coluna `knowledge_scope` junto do CHECK `chk_document_chunks_scope`:
   * `person` tem pessoa e organização, `client` tem cliente, `system` não tem
   * cliente nenhum. **Toda** consulta aqui filtra o nível explicitamente — não
   * é a ausência de `client_id` que separa o acervo geral do resto, porque uma
   * linha malformada faria essa ausência valer para todos os clientes.
   *
   * Escopo sem o mínimo para ser seguro — pessoa sem organização, cliente sem id
   * ou com caminho vazio ou com `..` — devolve vazio sem consultar, em vez de
   * consultar sem trava.
   */
  async searchSimilar({
    scope,
    embedding,
    embeddingModel,
  }: SearchSimilarParams): Promise<RetrievedChunk[]> {
    const query = this.documentChunksRepository
      .createQueryBuilder('chunk')
      .select('chunk.content', 'content')
      .addSelect('chunk.knowledge_scope', 'knowledgeScope')
      .addSelect('chunk.document_id', 'documentId')
      .addSelect('chunk.scope_path', 'scopePath')
      .addSelect('chunk.chunk_index', 'chunkIndex')
      .addSelect('chunk.page_number', 'pageNumber')
      .addSelect('chunk.embedding_model', 'embeddingModel')
      .addSelect('document.filename', 'filename')
      .addSelect('document.storage_path', 'storagePath')
      .addSelect('chunk.embedding <=> :embedding::vector', 'distance')
      .leftJoin(DocumentRecord, 'document', 'document.id = chunk.document_id');

    if (scope.kind === 'person') {
      if (!scope.organizationId) {
        return [];
      }

      query
        .where('chunk.knowledge_scope = :level', { level: 'person' })
        .andWhere('chunk.user_id = :userId', { userId: scope.userId })
        .andWhere('chunk.organization_id = :organizationId', { organizationId: scope.organizationId })
        .andWhere('(chunk.project_id = :projectId OR chunk.project_id IS NULL)', {
          projectId: scope.projectId,
        });
    } else if (scope.kind === 'system') {
      // O acervo geral: o filtro é o nível persistido, e ele é a trava inteira.
      // `client_id IS NULL` **não** entra como critério: seria a ausência de um
      // campo decidindo o compartilhamento, e é o CHECK que garante a ausência,
      // não a consulta.
      query
        .where('chunk.knowledge_scope = :level', { level: SYSTEM_SCOPE })
        .andWhere('chunk.client_id IS NULL');

      this.excludeFolders(query, scope);
    } else {
      if (!scope.clientId) {
        return [];
      }

      const pedeCaminho = String(scope.scopePath || '').trim().length > 0;
      const ancestors = scopePathAncestors(scope.scopePath);
      // Caminho pedido que não normaliza — vazio depois do `trim`, ou com `..` —
      // não vira consulta sem trava de pasta: pedido assim está errado, e
      // atendê-lo como "cliente inteiro" ampliaria justamente o escopo que ele
      // tentou restringir.
      if (pedeCaminho && ancestors.length === 0) {
        return [];
      }

      query
        .where('chunk.knowledge_scope = :level', { level: CLIENT_SCOPE })
        .andWhere('chunk.client_id = :clientId', { clientId: scope.clientId });
      if (!pedeCaminho) {
        // Cliente inteiro: sem cláusula de caminho nenhuma. O `client_id` é a
        // trava, e é ele que alcança todas as grafias sob as quais o acervo do
        // cliente foi gravado.
      } else if (scope.includeDescendants) {
        const root = ancestors[ancestors.length - 1];
        query.andWhere('(chunk.scope_path = :root OR starts_with(chunk.scope_path, :prefix))', {
          root,
          prefix: `${root}/`,
        });
      } else {
        query.andWhere('chunk.scope_path IN (:...ancestors)', { ancestors });
      }

      this.excludeFolders(query, scope);
    }

    if (embeddingModel) {
      query.andWhere(
        '(chunk.embedding_model IS NULL OR chunk.embedding_model = :embeddingModel)',
        { embeddingModel },
      );
    }

    const rows = await query
      // <=> (cosine) para bater com o índice HNSW vector_cosine_ops já criado.
      // O cast ::vector é obrigatório — sem ele o Postgres não resolve o
      // operador contra um parâmetro bind sem tipo.
      .orderBy('chunk.embedding <=> :embedding::vector')
      .setParameter('embedding', toSql(embedding))
      .limit(RAG_TOP_K)
      .getRawMany<RawRetrievedChunk>();

    return rows.map(toRetrievedChunk);
  }

  /**
   * O texto dos chunks de um documento, na ordem em que foi gravado.
   *
   * Só a coluna `content`: trazer a entity inteira arrastaria um `vector(768)`
   * por chunk, que não serve para nada de quem vai ler o documento.
   */
  async contentForDocument(documentId: string): Promise<string[]> {
    const rows = await this.documentChunksRepository
      .createQueryBuilder('chunk')
      .select('chunk.content', 'content')
      .where('chunk.document_id = :documentId', { documentId })
      .orderBy('chunk.chunk_index', 'ASC')
      .getRawMany<{ content: string }>();

    return rows.map((row) => row.content);
  }

  /**
   * Troca todos os chunks de um documento pelos novos, numa transação só.
   *
   * Reingerir um arquivo apaga o que havia antes: sem isso, uma segunda versão
   * do mesmo documento conviveria com a primeira e a busca devolveria o texto
   * antigo como se fosse atual.
   *
   * Grava o nível recebido e nunca o adivinha — `user_id` e `organization_id`
   * ficam nulos nos dois níveis de ingestão, e `client_id` só é preenchido no
   * nível `client`. É o lado do CHECK `chk_document_chunks_scope` que estas
   * linhas satisfazem, e é ele que recusa a combinação errada.
   */
  async replaceForDocument(params: ReplaceClientChunksParams): Promise<number> {
    const problem = scopeOwnershipProblem({ scope: params.scope, clientId: params.clientId });
    if (problem) throw new Error(problem);

    const clientId = params.scope === CLIENT_SCOPE ? params.clientId : null;

    return this.documentChunksRepository.manager.transaction(async (manager) => {
      await manager.delete(DocumentChunk, { documentId: params.documentId });

      for (let offset = 0; offset < params.chunks.length; offset += INSERT_BATCH_SIZE) {
        const batch = params.chunks.slice(offset, offset + INSERT_BATCH_SIZE);
        const rows: string[] = [];
        const values: unknown[] = [];

        for (const chunk of batch) {
          const base = values.length;
          rows.push(
            `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, ` +
              `$${base + 7}, $${base + 8}::vector, $${base + 9}, $${base + 10})`,
          );
          values.push(
            params.documentId,
            params.scope,
            clientId,
            params.scopePath,
            chunk.chunkIndex,
            chunk.pageNumber,
            chunk.content,
            toSql(chunk.embedding),
            params.embeddingModel,
            params.embeddingDimensions,
          );
        }

        await manager.query(
          `INSERT INTO document_chunks
             (document_id, knowledge_scope, client_id, scope_path, chunk_index, page_number,
              content, embedding, embedding_model, embedding_dimensions)
           VALUES ${rows.join(', ')}`,
          values,
        );
      }

      return params.chunks.length;
    });
  }

  /**
   * Aplica as exclusões de pasta a uma consulta já travada no nível.
   *
   * Comum aos dois acervos porque a regra é a mesma: pasta excluída sai da
   * busca com tudo abaixo dela.
   */
  private excludeFolders(
    query: SelectQueryBuilder<DocumentChunk>,
    scope: ClientScope | SystemScope,
  ): void {
    for (const [index, excluded] of excludedRootsOf(scope).entries()) {
      query.andWhere(
        `NOT (chunk.scope_path = :excluded${index} ` +
          `OR starts_with(chunk.scope_path, :excludedPrefix${index}))`,
        { [`excluded${index}`]: excluded, [`excludedPrefix${index}`]: `${excluded}/` },
      );
    }
  }
}
