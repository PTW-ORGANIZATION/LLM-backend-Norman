import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ConnectionRevisionsService } from './connection-revisions.service';
import { ProviderFailure, type LlmProvider } from './llm-provider.port';
import { LLM_PROVIDER } from './llm-provider.token';

export type ConnectionTestStatus = 'passed' | 'failed' | 'unconfigured';

export interface ConnectionTestResult {
  connectionKey: string;
  revision: number;
  status: ConnectionTestStatus;
  model: string | null;
  latencyMs: number;
  /** Motivo já redigido, sem chave, URL com credencial ou corpo do provedor. */
  message: string;
}

const PROBE = 'Responda apenas com ok';

/**
 * O teste de uma conexão provisionada, feito por quem executa a geração.
 *
 * Testar do outro lado provava outra coisa: outra rede, outra biblioteca, outro
 * conjunto de variáveis. Uma conexão aprovada lá podia falhar aqui, e o
 * administrador via verde numa tela e erro na conversa.
 *
 * A resposta nunca carrega chave, URL com credencial nem corpo devolvido pelo
 * provedor: o motivo é normalizado a partir do tipo da falha.
 */
@Injectable()
export class ConnectionTestService {
  private readonly logger = new Logger(ConnectionTestService.name);

  constructor(
    private readonly config: ConfigService,
    @Inject(LLM_PROVIDER)
    private readonly provider: LlmProvider,
    private readonly revisions: ConnectionRevisionsService,
  ) {}

  /**
   * Testa exatamente a revisão que depois será ativada.
   *
   * A revisão é resolvida no registro antes de qualquer chamada ao provedor: um
   * teste que aprovasse "a conexão" aprovaria uma configuração que a ativação
   * seguinte pode nem usar, e era assim que a revisão 2 herdava a aprovação da
   * revisão 1.
   */
  async test(input: { connectionKey: string; revision: number; model?: string }): Promise<ConnectionTestResult> {
    const revision = Number.isFinite(input.revision) ? Number(input.revision) : 0;

    let resolved: Awaited<ReturnType<ConnectionRevisionsService['require']>>;
    try {
      resolved = await this.revisions.require({
        connectionKey: input.connectionKey,
        revision,
        ...(input.model ? { model: input.model } : {}),
      });
    } catch (error) {
      return {
        connectionKey: String(input.connectionKey || ''),
        revision,
        status: 'unconfigured',
        model: String(input.model || '').trim() || null,
        latencyMs: 0,
        message: reasonOfRejection(error),
      };
    }

    const connection = resolved.connection;
    const model = resolved.record.model;

    const startedAt = Date.now();
    try {
      await this.provider.generate(connection, {
        model,
        messages: [{ role: 'user', content: PROBE }],
        temperature: 0,
        maxTokens: 8,
        json: false,
        timeoutMs: this.config.get<number>('gateway.connectionTestTimeoutMs', 15000),
      });
      return {
        connectionKey: connection.key,
        revision,
        status: 'passed',
        model,
        latencyMs: Date.now() - startedAt,
        message: 'conexão validada pelo backend de IA',
      };
    } catch (error) {
      const failure = error instanceof ProviderFailure
        ? error
        : new ProviderFailure('provider_error', 'falha não classificada');
      this.logger.warn(`Teste da conexão ${connection.key} falhou: ${failure.kind}`);
      return {
        connectionKey: connection.key,
        revision,
        status: 'failed',
        model,
        latencyMs: Date.now() - startedAt,
        message: reasonFor(failure.kind),
      };
    }
  }
}

/**
 * O motivo de uma recusa antes do provedor, já redigido.
 *
 * A recusa nasce aqui dentro, a partir da chave lógica e do número da revisão:
 * ela não carrega URL, credencial nem corpo do provedor, e por isso pode ir
 * inteira para a tela administrativa.
 */
function reasonOfRejection(error: unknown): string {
  return error instanceof Error && typeof (error as any).getResponse === 'function'
    ? String((error as any).getResponse()?.message ?? error.message)
    : error instanceof Error
    ? error.message
    : 'a revisão não foi reconhecida por este backend';
}

/**
 * O motivo que sai na resposta, por tipo de falha.
 *
 * Normalizado de propósito: a mensagem do provedor às vezes ecoa o cabeçalho
 * enviado, e ela iria parar na tela administrativa e no banco do Norman.
 */
function reasonFor(kind: string): string {
  switch (kind) {
    case 'timeout':
      return 'o provedor não respondeu dentro do tempo do teste';
    case 'authorization':
      return 'a credencial provisionada foi recusada pelo provedor';
    case 'rate_limited':
      return 'o provedor recusou por limite de uso';
    case 'unavailable':
      return 'não foi possível alcançar o provedor';
    case 'invalid_request':
      return 'o provedor recusou o pedido de teste';
    case 'misconfigured':
      return 'a conexão não está provisionada por completo neste backend';
    default:
      return 'o provedor falhou ao responder o teste';
  }
}
