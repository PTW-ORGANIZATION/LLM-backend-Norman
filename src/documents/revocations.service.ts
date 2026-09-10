import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { KnowledgeRevocation, RevocationKind } from './knowledge-revocation.entity';
import {
  CLIENT_SCOPE,
  IngestionScope,
  scopeOwnershipProblem,
  SYSTEM_SCOPE,
} from './knowledge-scope';

export interface RevokeResult {
  /** Documentos que saíram fisicamente do acervo nesta chamada. */
  removed: number;
  /** Lápides vigentes para o alvo depois desta chamada. Nunca zero em sucesso. */
  tombstones: number;
}

/**
 * A cláusula que diz se uma lápide alcança um caminho.
 *
 * O número do parâmetro é explícito porque as consultas dos dois níveis têm
 * listas de parâmetros diferentes — a do acervo geral não tem cliente — e o
 * Postgres recusa uma consulta que receba um parâmetro que ela não menciona.
 */
function coversPath(pathParam: number): string {
  const path = `$${pathParam}`;
  return (
    `("kind" = 'path' AND "path" = ${path}) `
    + `OR ("kind" = 'prefix' AND ("path" = ${path} OR left(${path}, length("path") + 1) = "path" || '/'))`
  );
}

/**
 * A condição de dono de uma lápide, pelo nível, e os parâmetros que ela usa.
 *
 * No acervo de cliente é o `client_id`; no acervo geral é o nível junto da
 * ausência dele. O nível entra sempre: sem ele, uma lápide geral e uma lápide
 * de cliente com o mesmo caminho se confundiriam, e revogar o arquivo geral
 * tiraria de circulação o homônimo de um cliente.
 */
function owner(scope: IngestionScope, clientId: string | null) {
  return scope === SYSTEM_SCOPE
    ? { clause: `"knowledge_scope" = 'system' AND "client_id" IS NULL`, params: [] as unknown[], next: 1 }
    : {
        clause: `"knowledge_scope" = 'client' AND "client_id" = $1`,
        params: [clientId] as unknown[],
        next: 2,
      };
}

/**
 * A exclusão lógica do acervo, e a remoção física que vem junto com ela.
 *
 * A lápide é gravada **antes** de qualquer linha ser apagada, e na mesma
 * transação: ou a revogação inteira vale, ou nada dela valeu e quem pediu
 * recebe erro. Não existe estado em que o Norman dá a fonte por revogada e o
 * acervo continua servindo os trechos dela.
 *
 * Ela sobrevive à remoção física porque o arquivo continua no repositório do
 * Norman: sem a lápide, o resync seguinte reindexaria o que alguém acabou de
 * tirar de circulação, e a revogação duraria até a próxima sincronização.
 *
 * Os dois níveis de acervo têm identidades diferentes — cliente + tipo +
 * caminho no acervo de cliente, tipo + caminho no acervo geral — e cada um tem
 * o próprio índice único parcial. É por isso que o `ON CONFLICT` cita o
 * predicado do índice: um `INSERT` que não o citasse não encontraria árbitro no
 * acervo geral e duplicaria a lápide.
 */
@Injectable()
export class RevocationsService {
  constructor(
    @InjectRepository(KnowledgeRevocation)
    private readonly revocations: Repository<KnowledgeRevocation>,
  ) {}

  /**
   * Revoga um arquivo pelo caminho exato.
   *
   * Idempotente: repetir a chamada reencontra a mesma lápide, não remove nada de
   * novo e devolve o mesmo estado. É o que permite ao Norman reenviar uma
   * invalidação que ele não sabe se chegou.
   */
  revokePath(input: {
    scope?: IngestionScope;
    clientId?: string | null;
    storagePath: string;
    reason?: string | null;
  }) {
    return this.revoke({
      scope: input.scope ?? CLIENT_SCOPE,
      clientId: input.clientId ?? null,
      kind: RevocationKind.PATH,
      path: input.storagePath,
      reason: input.reason ?? null,
      documentWhere: (pathParam) => `storage_path = $${pathParam}`,
    });
  }

  /** Revoga uma pasta inteira e tudo abaixo dela. */
  revokePrefix(input: {
    scope?: IngestionScope;
    clientId?: string | null;
    scopePath: string;
    reason?: string | null;
  }) {
    return this.revoke({
      scope: input.scope ?? CLIENT_SCOPE,
      clientId: input.clientId ?? null,
      kind: RevocationKind.PREFIX,
      path: input.scopePath,
      reason: input.reason ?? null,
      documentWhere: (pathParam) => {
        const path = `$${pathParam}`;
        return `(scope_path = ${path} OR left(scope_path, length(${path}) + 1) = ${path} || '/')`;
      },
    });
  }

  /**
   * Diz se um caminho está fora de circulação.
   *
   * Vale tanto a lápide do próprio arquivo quanto a de qualquer pasta acima
   * dele: revogar uma pasta e ver seus arquivos voltarem um a um não seria
   * revogação.
   */
  async isRevoked(
    clientId: string | null,
    storagePath: string,
    scope: IngestionScope = CLIENT_SCOPE,
  ): Promise<boolean> {
    const dono = owner(scope, clientId);
    const rows = await this.revocations.manager.query(
      `SELECT 1 FROM knowledge_revocations
        WHERE ${dono.clause} AND (${coversPath(dono.next)}) LIMIT 1`,
      [...dono.params, storagePath],
    );
    return Array.isArray(rows) && rows.length > 0;
  }

  /** As lápides vigentes de um cliente, da mais recente para a mais antiga. */
  listForClient(clientId: string): Promise<KnowledgeRevocation[]> {
    return this.revocations.find({
      where: { knowledgeScope: CLIENT_SCOPE, clientId },
      order: { revokedAt: 'DESC' },
    });
  }

  /** As lápides vigentes do acervo geral do sistema. */
  listForSystem(): Promise<KnowledgeRevocation[]> {
    return this.revocations.find({
      where: { knowledgeScope: SYSTEM_SCOPE },
      order: { revokedAt: 'DESC' },
    });
  }

  /**
   * Levanta a lápide de um caminho para que ele possa voltar ao acervo.
   *
   * Só a lápide do próprio caminho sai. Pasta revogada continua revogada: um
   * arquivo reenviado dentro dela não é decisão de restaurar a pasta inteira, e
   * tratá-lo assim traria de volta tudo o que estava fora de circulação.
   */
  async lift(
    clientId: string | null,
    path: string,
    scope: IngestionScope = CLIENT_SCOPE,
  ): Promise<number> {
    const query = this.revocations
      .createQueryBuilder()
      .delete()
      .where('knowledge_scope = :level', { level: scope })
      .andWhere('path = :path', { path });

    if (scope === SYSTEM_SCOPE) {
      query.andWhere('client_id IS NULL');
    } else {
      query.andWhere('client_id = :clientId', { clientId });
    }

    const result = await query.execute();
    return result.affected ?? 0;
  }

  private async revoke(input: {
    scope: IngestionScope;
    clientId: string | null;
    kind: RevocationKind;
    path: string;
    reason: string | null;
    documentWhere: (pathParam: number) => string;
  }): Promise<RevokeResult> {
    const problem = scopeOwnershipProblem({ scope: input.scope, clientId: input.clientId });
    if (problem) throw new Error(problem);

    const dono = owner(input.scope, input.clientId);
    const conflictTarget =
      input.scope === SYSTEM_SCOPE
        ? `(kind, path) WHERE knowledge_scope = 'system'`
        : `(client_id, kind, path) WHERE knowledge_scope = 'client'`;

    // A condição de dono das linhas de `documents` é a mesma da lápide, sem as
    // aspas do identificador citado: as duas tabelas têm as mesmas colunas de
    // nível e de dono, e usar duas escritas diferentes as deixaria divergir.
    const documentOwner = dono.clause.replace(/"/g, '');

    return this.revocations.manager.transaction(async (manager) => {
      await manager.query(
        `INSERT INTO knowledge_revocations
           (knowledge_scope, client_id, kind, path, reason, revoked_at)
         VALUES ($1, $2, $3, $4, $5, now())
         ON CONFLICT ${conflictTarget} DO NOTHING`,
        [
          input.scope,
          input.scope === SYSTEM_SCOPE ? null : input.clientId,
          input.kind,
          input.path,
          input.reason,
        ],
      );

      const removed = await manager.query(
        `DELETE FROM documents WHERE ${documentOwner} AND ${input.documentWhere(dono.next)}`,
        [...dono.params, input.path],
      );

      const tombstones = await manager.query(
        `SELECT count(*)::int AS total FROM knowledge_revocations
          WHERE ${dono.clause} AND (${coversPath(dono.next)})`,
        [...dono.params, input.path],
      );

      return {
        // O driver devolve `[linhas, total]` num DELETE. É o total que interessa.
        removed: Array.isArray(removed) && typeof removed[1] === 'number' ? removed[1] : 0,
        tombstones: Number(tombstones?.[0]?.total ?? 0),
      };
    });
  }
}
