import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DocumentRecord, DocumentStatus } from './document.entity';
import {
  CLIENT_SCOPE,
  IngestionScope,
  scopeOwnershipProblem,
  SYSTEM_SCOPE,
} from './knowledge-scope';

const MAX_FAILURE_REASON_CHARS = 2000;

export interface RegisterClientDocumentInput {
  /**
   * O nível do acervo em que este documento entra.
   *
   * Vem declarado por quem registra e nunca é inferido do caminho: uma pasta
   * chamada "geral" não torna nada compartilhado, e a falta acidental de
   * `clientId` é recusada em vez de virar acervo de todos.
   */
  scope: IngestionScope;
  clientId: string | null;
  scopePath: string;
  storagePath: string;
  filename: string;
  sha256: string;
  mimeType?: string | null;
  sizeBytes?: number | null;
}

export interface RegisterClientDocumentResult {
  document: DocumentRecord;
  /** Falso quando o mesmo conteúdo já estava registrado naquele caminho. */
  changed: boolean;
}

@Injectable()
export class DocumentsService {
  constructor(
    @InjectRepository(DocumentRecord)
    private readonly documentsRepository: Repository<DocumentRecord>,
  ) {}

  findById(id: string): Promise<DocumentRecord | null> {
    return this.documentsRepository.findOne({ where: { id } });
  }

  /**
   * O documento de um caminho exato dentro de um cliente.
   *
   * O par cliente + caminho é a identidade de um documento no acervo, e é por
   * ele que o Norman pede reprocessamento: a tela conhece o arquivo, não o uuid
   * que este serviço gerou.
   */
  findByClientPath(clientId: string, storagePath: string): Promise<DocumentRecord | null> {
    return this.documentsRepository.findOne({
      where: { knowledgeScope: CLIENT_SCOPE, clientId, storagePath },
    });
  }

  /**
   * O documento de um caminho exato do acervo geral do sistema.
   *
   * A identidade aqui é só o caminho, porque não há cliente para compor a
   * chave — e o nível entra na condição para que um caminho de cliente com a
   * mesma grafia nunca seja devolvido como se fosse do acervo geral.
   */
  findBySystemPath(storagePath: string): Promise<DocumentRecord | null> {
    return this.documentsRepository.findOne({
      where: { knowledgeScope: SYSTEM_SCOPE, storagePath },
    });
  }

  /** O documento de um caminho no nível informado. */
  findByScopePath(
    scope: IngestionScope,
    clientId: string | null,
    storagePath: string,
  ): Promise<DocumentRecord | null> {
    return scope === SYSTEM_SCOPE
      ? this.findBySystemPath(storagePath)
      : this.findByClientPath(String(clientId || ''), storagePath);
  }

  /** Devolve o documento para a fila, como se tivesse acabado de ser registrado. */
  async markPending(id: string): Promise<void> {
    await this.documentsRepository.update(id, {
      status: DocumentStatus.PENDING,
      failureReason: null,
    });
  }

  /**
   * Registra (ou atualiza) o documento de um arquivo do repositório do Norman.
   *
   * A identidade de um documento é o par cliente + caminho de armazenamento, não
   * o conteúdo: reenviar o mesmo caminho atualiza a linha. O `sha256` decide se
   * há trabalho a fazer — conteúdo igual devolve `changed: false` e não mexe no
   * status, para que um resync não jogue fora chunks já vetorizados.
   */
  async registerClientDocument(
    input: RegisterClientDocumentInput,
  ): Promise<RegisterClientDocumentResult> {
    const problem = scopeOwnershipProblem({ scope: input.scope, clientId: input.clientId });
    if (problem) throw new Error(problem);

    const clientId = input.scope === CLIENT_SCOPE ? input.clientId : null;
    const existing = await this.findByScopePath(input.scope, clientId, input.storagePath);

    if (existing && existing.sha256 === input.sha256 && existing.status === DocumentStatus.READY) {
      return { document: existing, changed: false };
    }

    const patch = {
      knowledgeScope: input.scope,
      clientId,
      scopePath: input.scopePath,
      storagePath: input.storagePath,
      filename: input.filename,
      sha256: input.sha256,
      mimeType: input.mimeType ?? null,
      sizeBytes: input.sizeBytes === null || input.sizeBytes === undefined
        ? null
        : String(input.sizeBytes),
      status: DocumentStatus.PENDING,
    };

    const document = await this.documentsRepository.save(
      existing
        ? this.documentsRepository.merge(existing, patch)
        : this.documentsRepository.create(patch),
    );

    return { document, changed: true };
  }

  /**
   * Marca o documento como `ready` e grava qual extrator o leu.
   *
   * As duas escritas andam juntas de propósito: um documento pronto sem origem
   * registrada não deixa a operação distinguir leitura direta de OCR, que é o
   * que decide se vale reprocessar.
   */
  async markReady(id: string, extractionSource: string): Promise<void> {
    await this.documentsRepository.update(id, {
      status: DocumentStatus.READY,
      extractionSource,
      failureReason: null,
    });
  }

  /**
   * Marca o documento como `processing` e limpa o motivo da falha anterior.
   *
   * A limpeza é o ponto: sem ela um reprocessamento em andamento apareceria na
   * tela como "Lendo" com o erro da tentativa passada ainda ao lado.
   */
  async markProcessing(id: string): Promise<void> {
    await this.documentsRepository.update(id, {
      status: DocumentStatus.PROCESSING,
      failureReason: null,
    });
  }

  /**
   * Marca o documento como `failed` guardando o motivo.
   *
   * O motivo é truncado porque mensagem de erro de biblioteca às vezes vem com
   * despejo de estrutura interna, e a coluna serve para a tela explicar o que
   * aconteceu, não para arquivar o erro inteiro.
   */
  async markFailed(id: string, reason: string): Promise<void> {
    await this.documentsRepository.update(id, {
      status: DocumentStatus.FAILED,
      failureReason: String(reason || 'falha sem mensagem').slice(0, MAX_FAILURE_REASON_CHARS),
    });
  }

  /**
   * Esquece um arquivo pelo caminho exato. Os chunks vão junto pelo ON DELETE
   * CASCADE da FK.
   */
  async forgetPath(input: {
    scope: IngestionScope;
    clientId: string | null;
    storagePath: string;
  }): Promise<number> {
    const result = await this.documentsRepository.delete(
      input.scope === SYSTEM_SCOPE
        ? { knowledgeScope: SYSTEM_SCOPE, storagePath: input.storagePath }
        : {
            knowledgeScope: CLIENT_SCOPE,
            clientId: String(input.clientId || ''),
            storagePath: input.storagePath,
          },
    );
    return result.affected ?? 0;
  }

  /**
   * Esquece uma pasta inteira e tudo abaixo dela.
   *
   * A comparação de prefixo é feita por `left(...)`, e não por `LIKE`: nome de
   * pasta do Norman é cheio de `_`, que é curinga de um caractere no `LIKE`, e um
   * padrão vindo do próprio caminho apagaria pasta irmã. Igualdade não tem
   * curinga.
   */
  async forgetPrefix(input: {
    scope: IngestionScope;
    clientId: string | null;
    scopePath: string;
  }): Promise<number> {
    const query = this.documentsRepository
      .createQueryBuilder()
      .delete()
      .where('knowledge_scope = :level', { level: input.scope });

    if (input.scope === SYSTEM_SCOPE) {
      query.andWhere('client_id IS NULL');
    } else {
      query.andWhere('client_id = :clientId', { clientId: input.clientId });
    }

    const result = await query
      .andWhere(
        '(scope_path = :prefix OR left(scope_path, length(:prefix) + 1) = :prefix || \'/\')',
        { prefix: input.scopePath },
      )
      .execute();
    return result.affected ?? 0;
  }

  /**
   * Move o escopo de uma pasta para outro caminho **sem revetorizar**.
   *
   * O embedding descreve o texto, não o lugar onde o arquivo está: renomear uma
   * pasta com mil documentos não pode custar mil chamadas ao modelo. Documento e
   * chunk são atualizados na mesma transação, senão a busca passaria a recuperar
   * por um caminho que os documentos já não têm.
   */
  async renamePrefix(input: {
    scope: IngestionScope;
    clientId: string | null;
    fromPath: string;
    toPath: string;
  }): Promise<number> {
    if (input.fromPath === input.toPath) return 0;

    // O dono entra na condição pelo nível: no acervo de cliente é o `client_id`,
    // e no acervo geral é a ausência dele junto do nível. Renomear uma pasta
    // geral não pode alcançar pasta de cliente com a mesma grafia.
    const system = input.scope === SYSTEM_SCOPE;
    const ownerCondition = system
      ? "knowledge_scope = 'system' AND client_id IS NULL"
      : "knowledge_scope = 'client' AND client_id = $1";
    // O acervo geral não tem cliente, então a consulta dele tem um parâmetro
    // menos e os caminhos deslizam para `$1` e `$2`. Passar um parâmetro que a
    // consulta não menciona é recusado pelo Postgres.
    const from = system ? '$1' : '$2';
    const to = system ? '$2' : '$3';
    const params = system ? [input.fromPath, input.toPath] : [input.clientId, input.fromPath, input.toPath];

    return this.documentsRepository.manager.transaction(async (manager) => {
      const scopeCondition =
        `(scope_path = ${from} OR left(scope_path, length(${from}) + 1) = ${from} || '/')`;
      const movedScope = `${to} || substring(scope_path from length(${from}) + 1)`;

      const documents = await manager.query(
        `UPDATE documents
            SET scope_path = ${movedScope},
                storage_path = CASE
                  WHEN left(storage_path, length(${from}) + 1) = ${from} || '/'
                    THEN ${to} || substring(storage_path from length(${from}) + 1)
                  ELSE storage_path
                END,
                updated_at = now()
          WHERE ${ownerCondition} AND ${scopeCondition}`,
        params,
      );

      await manager.query(
        `UPDATE document_chunks
            SET scope_path = ${movedScope}
          WHERE ${ownerCondition} AND ${scopeCondition}`,
        params,
      );

      return Array.isArray(documents) && typeof documents[1] === 'number' ? documents[1] : 0;
    });
  }
}
