import { createHash } from 'node:crypto';
import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { QueryFailedError, Repository } from 'typeorm';
import { ConnectionActivation } from './connection-activation.entity';
import { ConnectionRevision } from './connection-revision.entity';
import { resolveConnection, type ResolvedConnection } from './provider-connection';

export interface RevisionSyncInput {
  connectionKey: string;
  revision: number;
  model: string;
  enabled?: boolean;
}

export interface RecognizedRevision {
  connectionKey: string;
  revision: number;
  model: string;
  configDigest: string;
  isEnabled: boolean;
  createdAt: Date;
}

export interface ConfirmedActivation {
  activationId: string;
  connectionKey: string;
  revision: number;
  model: string;
  confirmedAt: Date;
}

export interface ResolvedRevision {
  record: RecognizedRevision;
  connection: Extract<ResolvedConnection, { available: true }>;
  activation: ConfirmedActivation | null;
}

/**
 * O digest do provisionamento de uma conexão.
 *
 * Resume o que este executor tem provisionado — destino e catálogo permitido —
 * sem carregar a URL nem qualquer parte do segredo: só o comprimento e um hash
 * salgado da chave entram, o suficiente para trocar a credencial invalidar a
 * revisão aprovada, e não o bastante para reconstruí-la.
 */
export function configDigestOf(connection: Extract<ResolvedConnection, { available: true }>): string {
  const material = JSON.stringify({
    key: connection.key,
    protocol: connection.protocol,
    baseUrl: connection.baseUrl,
    allowedModels: [...connection.allowedModels].sort(),
    apiKey: connection.apiKey
      ? createHash('sha256').update(`provisionamento:${connection.apiKey}`).digest('hex')
      : null,
  });
  return createHash('sha256').update(material).digest('hex').slice(0, 64);
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof QueryFailedError && (error as any).driverError?.code === '23505';
}

/**
 * O registro das revisões de conexão que este executor reconhece, e das
 * ativações que ele confirmou.
 *
 * O plano de controle mora no Norman e a configuração executável mora aqui. O
 * que atravessa é só metadado — chave lógica, número da revisão e modelo —, e é
 * este registro que transforma o número recebido no corpo em algo verificável:
 * sem ele, revisão 2 executava em silêncio com a configuração da revisão 1.
 *
 * A ativação é linha própria, e não campo da revisão: campo é sobrescrevível, e
 * uma tentativa posterior apagava o vínculo que estava valendo.
 */
@Injectable()
export class ConnectionRevisionsService {
  constructor(
    @InjectRepository(ConnectionRevision)
    private readonly revisions: Repository<ConnectionRevision>,
    @InjectRepository(ConnectionActivation)
    private readonly activations: Repository<ConnectionActivation>,
  ) {}

  /**
   * Registra (ou reconhece de novo) uma revisão, sem receber URL nem segredo.
   *
   * Idempotente pelos mesmos valores. O modelo é validado contra a allowlist
   * deste executor, e não contra a de quem sincroniza: allowlist do outro lado
   * aprovaria modelo que aqui não existe.
   *
   * Nunca toca em ativação: sincronizar é reconhecer configuração, e reconhecer
   * uma revisão nova não pode mexer no que já está ativo nem no fallback já
   * aprovado.
   */
  async sync(input: RevisionSyncInput): Promise<RecognizedRevision> {
    const connection = this.requireAvailable(input.connectionKey);
    const revision = Number(input.revision);
    if (!Number.isInteger(revision) || revision < 0) {
      throw new BadRequestException('a revisão precisa ser um inteiro não negativo');
    }

    const model = String(input.model || '').trim() || connection.defaultModel;
    if (!connection.allowedModels.includes(model)) {
      throw new BadRequestException(
        `o modelo "${model}" não está entre os permitidos da conexão "${connection.key}"`,
      );
    }

    const configDigest = configDigestOf(connection);
    const existing = await this.find(connection.key, revision);

    if (existing) {
      if (existing.model !== model) {
        throw new ConflictException(
          `a revisão ${revision} de "${connection.key}" já foi reconhecida com o modelo ` +
            `"${existing.model}"; crie uma revisão nova para trocar de modelo`,
        );
      }
      if (existing.configDigest !== configDigest) {
        throw new ConflictException(
          `a revisão ${revision} de "${connection.key}" foi reconhecida sobre outro ` +
            'provisionamento; crie uma revisão nova depois de mudar a configuração',
        );
      }
      existing.isEnabled = input.enabled ?? existing.isEnabled;
      return this.view(await this.revisions.save(existing));
    }

    const created = this.revisions.create({
      connectionKey: connection.key,
      revision,
      model,
      configDigest,
      isEnabled: input.enabled ?? true,
      activationId: null,
    });
    return this.view(await this.revisions.save(created));
  }

  /**
   * Confirma uma ativação para a tupla exata identidade + chave + revisão.
   *
   * É o passo que fecha o protocolo de preparação e confirmação: o Norman cria a
   * identidade antes de chamar, e só torna a ativação vigente depois de esta
   * confirmação existir aqui.
   *
   * Idempotente pela tupla: repetir depois de um timeout devolve a mesma
   * confirmação em vez de criar outra linha, e é assim que a repetição descobre
   * que a chamada anterior tinha chegado. A mesma identidade apontando para
   * outra revisão é recusada, e uma confirmação nova nunca apaga uma anterior.
   */
  async confirmActivation(input: {
    connectionKey: string;
    revision: number;
    activationId: string;
  }): Promise<ConfirmedActivation> {
    const activationId = String(input.activationId || '').trim();
    if (!activationId) throw new BadRequestException('a ativação precisa de um identificador');

    const resolved = await this.require({
      connectionKey: input.connectionKey,
      revision: input.revision,
    });
    const { record, connection } = resolved;

    const existing = await this.activations.findOne({ where: { activationId } });
    if (existing) {
      if (existing.connectionKey !== connection.key || existing.revision !== record.revision) {
        throw new ConflictException(
          `a ativação "${activationId}" já foi confirmada para a revisão ${existing.revision} de ` +
            `"${existing.connectionKey}"; use uma identidade nova para outra revisão`,
        );
      }
      if (existing.configDigest !== record.configDigest) {
        throw new ConflictException(
          `a ativação "${activationId}" foi confirmada sobre outro provisionamento; ` +
            'sincronize e ative uma revisão nova',
        );
      }
      return this.activationView(existing);
    }

    const created = this.activations.create({
      activationId,
      connectionKey: connection.key,
      revision: record.revision,
      model: record.model,
      configDigest: record.configDigest,
    });

    try {
      return this.activationView(await this.activations.save(created));
    } catch (error) {
      // Duas confirmações da mesma identidade ao mesmo tempo: a que perdeu a
      // corrida lê a linha da que ganhou, em vez de devolver erro para uma
      // repetição que, do ponto de vista de quem chamou, deu certo.
      if (!isUniqueViolation(error)) throw error;
      const gravada = await this.activations.findOne({ where: { activationId } });
      if (!gravada) throw error;
      if (gravada.connectionKey !== connection.key || gravada.revision !== record.revision) {
        throw new ConflictException(
          `a ativação "${activationId}" já foi confirmada para a revisão ${gravada.revision} de ` +
            `"${gravada.connectionKey}"; use uma identidade nova para outra revisão`,
        );
      }
      return this.activationView(gravada);
    }
  }

  /**
   * A confirmação de uma identidade de ativação, ou nulo.
   *
   * É o que o plano de controle consulta para reconciliar: depois de um timeout,
   * ele não pode presumir que a confirmação não aconteceu, e esta leitura é o
   * que diz a verdade sem repetir a operação.
   */
  async findActivation(activationId: string): Promise<ConfirmedActivation | null> {
    const identidade = String(activationId || '').trim();
    if (!identidade) return null;
    const row = await this.activations.findOne({ where: { activationId: identidade } });
    return row ? this.activationView(row) : null;
  }

  /** As confirmações de uma revisão, da mais recente para a mais antiga. */
  async activationsOf(connectionKey: string, revision: number): Promise<ConfirmedActivation[]> {
    const key = String(connectionKey || '').trim().toLowerCase();
    const numero = Number(revision);
    if (!Number.isInteger(numero) || numero < 0) return [];
    const rows = await this.activations.find({
      where: { connectionKey: key, revision: numero },
      order: { confirmedAt: 'DESC' },
    });
    return rows.map((row) => this.activationView(row));
  }

  async describe(connectionKey: string): Promise<Array<RecognizedRevision & { activationIds: string[] }>> {
    const key = String(connectionKey || '').trim().toLowerCase();
    const rows = await this.revisions.find({
      where: { connectionKey: key },
      order: { revision: 'DESC' },
    });
    if (rows.length === 0) return [];

    const confirmadas = await this.activations.find({ where: { connectionKey: key } });
    return rows.map((row) => ({
      ...this.view(row),
      activationIds: confirmadas
        .filter((item) => item.revision === row.revision)
        .map((item) => item.activationId),
    }));
  }

  /**
   * A revisão exata que a geração e o teste devem usar.
   *
   * Recusa antes de o provedor ser chamado: revisão inexistente, desabilitada,
   * de outra conexão ou com modelo divergente do registrado não vira requisição
   * ao fornecedor.
   *
   * Quando `activationId` é informado, a identidade precisa estar confirmada
   * para esta chave e esta revisão. Identidade pendente no plano de controle,
   * falha, inventada ou pertencente a outra revisão não tem linha aqui, e a
   * geração para antes do adapter.
   */
  async require(input: {
    connectionKey: string;
    revision: number;
    model?: string;
    activationId?: string;
  }): Promise<ResolvedRevision> {
    const connection = this.requireAvailable(input.connectionKey);
    const record = await this.find(connection.key, input.revision);
    if (!record) {
      throw new BadRequestException(
        `a revisão ${input.revision} da conexão "${connection.key}" não é reconhecida por este backend`,
      );
    }
    if (!record.isEnabled) {
      throw new BadRequestException(
        `a revisão ${input.revision} da conexão "${connection.key}" está desabilitada`,
      );
    }

    const requested = String(input.model || '').trim();
    if (requested && requested !== record.model) {
      throw new BadRequestException(
        `a revisão ${input.revision} de "${connection.key}" foi reconhecida com o modelo ` +
          `"${record.model}", e não com "${requested}"`,
      );
    }
    if (!connection.allowedModels.includes(record.model)) {
      throw new BadRequestException(
        `o modelo "${record.model}" da revisão ${input.revision} saiu da allowlist da conexão ` +
          `"${connection.key}"`,
      );
    }
    if (configDigestOf(connection) !== record.configDigest) {
      throw new BadRequestException(
        `a revisão ${input.revision} de "${connection.key}" foi reconhecida sobre outro ` +
          'provisionamento; sincronize uma revisão nova',
      );
    }

    let activation: ConfirmedActivation | null = null;
    if (input.activationId !== undefined) {
      const activationId = String(input.activationId || '').trim();
      const confirmada = activationId
        ? await this.activations.findOne({ where: { activationId } })
        : null;
      if (!confirmada) {
        throw new BadRequestException(
          `a ativação informada não está confirmada neste backend para a revisão ` +
            `${input.revision} de "${connection.key}"`,
        );
      }
      if (confirmada.connectionKey !== connection.key || confirmada.revision !== record.revision) {
        throw new BadRequestException(
          `a ativação informada foi confirmada para a revisão ${confirmada.revision} de ` +
            `"${confirmada.connectionKey}", e não para a revisão ${input.revision} de ` +
            `"${connection.key}"`,
        );
      }
      if (confirmada.model !== record.model || confirmada.configDigest !== record.configDigest) {
        throw new BadRequestException(
          `a ativação informada foi confirmada sobre outra configuração da revisão ` +
            `${input.revision} de "${connection.key}"`,
        );
      }
      activation = this.activationView(confirmada);
    }

    return { record: this.view(record), connection, activation };
  }

  private async find(connectionKey: string, revision: number): Promise<ConnectionRevision | null> {
    const key = String(connectionKey || '').trim().toLowerCase();
    const numero = Number(revision);
    if (!Number.isInteger(numero) || numero < 0) return null;
    return this.revisions.findOne({ where: { connectionKey: key, revision: numero } });
  }

  private requireAvailable(connectionKey: string): Extract<ResolvedConnection, { available: true }> {
    const connection = resolveConnection(connectionKey);
    if (!connection.available) {
      throw new BadRequestException(
        `conexão "${connectionKey}" indisponível neste backend: ${connection.reason}`,
      );
    }
    return connection;
  }

  private view(row: ConnectionRevision): RecognizedRevision {
    return {
      connectionKey: row.connectionKey,
      revision: row.revision,
      model: row.model,
      configDigest: row.configDigest,
      isEnabled: row.isEnabled,
      createdAt: row.createdAt,
    };
  }

  private activationView(row: ConnectionActivation): ConfirmedActivation {
    return {
      activationId: row.activationId,
      connectionKey: row.connectionKey,
      revision: row.revision,
      model: row.model,
      confirmedAt: row.confirmedAt,
    };
  }
}
