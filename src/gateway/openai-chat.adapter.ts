import { Injectable, Optional } from '@nestjs/common';
import type { ResolvedConnection } from './provider-connection';
import {
  ProviderFailure,
  type LlmProvider,
  type ProviderCapabilities,
  type ProviderRequest,
  type ProviderResponse,
  type ProviderStreamEvent,
} from './llm-provider.port';

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string | null } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

interface ChatCompletionChunk {
  choices?: Array<{ delta?: { content?: string | null } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
}

const STREAM_DONE = '[DONE]';

const KEY_SHAPED = /\b(?:sk|xai|gsk|pk|key)[-_][A-Za-z0-9._-]{8,}/gi;
const BEARER = /(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi;
const MAX_BODY_DETAIL = 200;

/**
 * O que o provedor disse, em forma segura de carregar num erro.
 *
 * Sem isto, a recusa mais comum — modelo inexistente — chegava como
 * "o provedor recusou o pedido (404)" e não dizia qual modelo. O corpo é
 * resposta de serviço externo, então vai redigido: nada com forma de chave
 * atravessa para log, auditoria ou tela.
 */
function detailOf(body: string): string {
  const texto = String(body || '')
    .replace(/\s+/g, ' ')
    .replace(BEARER, '$1***')
    .replace(KEY_SHAPED, '***')
    .trim();
  if (!texto) return '';
  return `: ${texto.slice(0, MAX_BODY_DETAIL)}`;
}

function failureFromStatus(status: number, body: string): ProviderFailure {
  const detalhe = detailOf(body);
  if (status === 401 || status === 403) {
    return new ProviderFailure('authorization', `o provedor recusou a credencial${detalhe}`, status);
  }
  if (status === 400 || status === 404 || status === 422) {
    return new ProviderFailure(
      'invalid_request',
      `o provedor recusou o pedido (${status})${detalhe}`,
      status,
    );
  }
  if (status === 429) {
    return new ProviderFailure(
      'rate_limited',
      `o provedor recusou por limite de uso${detalhe}`,
      status,
    );
  }
  if (status >= 500) {
    return new ProviderFailure('unavailable', `o provedor respondeu ${status}${detalhe}`, status);
  }
  return new ProviderFailure('provider_error', `o provedor respondeu ${status}${detalhe}`, status);
}

/**
 * Transporte compartilhado pelos provedores que falam a API de chat compatível
 * com a da OpenAI.
 *
 * Um transporte só para os três não significa que eles sejam intercambiáveis: a
 * conexão declara o protocolo, e provedor com protocolo diferente exige adapter
 * próprio. Um link sozinho não garante compatibilidade.
 */
@Injectable()
export class OpenAiChatAdapter implements LlmProvider {
  readonly protocol = 'openai_chat';

  constructor(@Optional() private readonly fetchImpl: typeof fetch = fetch) {}

  capabilities(): ProviderCapabilities {
    return { streaming: true, structuredOutput: true, vision: false, cancellation: true };
  }

  async generate(
    connection: Extract<ResolvedConnection, { available: true }>,
    request: ProviderRequest,
  ): Promise<ProviderResponse> {
    const { signal, dispose } = this.abortPlan(request);

    try {
      const response = await this.fetchImpl(`${connection.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(connection.apiKey ? { Authorization: `Bearer ${connection.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: request.model,
          messages: request.messages,
          ...(typeof request.temperature === 'number' ? { temperature: request.temperature } : {}),
          ...(typeof request.maxTokens === 'number' ? { max_tokens: request.maxTokens } : {}),
          ...(request.json ? { response_format: { type: 'json_object' } } : {}),
        }),
        signal,
      });

      if (!response.ok) {
        throw failureFromStatus(response.status, await response.text().catch(() => ''));
      }

      const payload = (await response.json()) as ChatCompletionResponse;
      const text = String(payload?.choices?.[0]?.message?.content || '');
      if (!text.trim()) {
        throw new ProviderFailure('provider_error', 'o provedor devolveu resposta vazia');
      }

      return {
        text,
        promptTokens: Number.isFinite(payload?.usage?.prompt_tokens as number)
          ? (payload!.usage!.prompt_tokens as number)
          : null,
        completionTokens: Number.isFinite(payload?.usage?.completion_tokens as number)
          ? (payload!.usage!.completion_tokens as number)
          : null,
      };
    } catch (error) {
      throw this.asFailure(error, request);
    } finally {
      dispose();
    }
  }

  /**
   * A geração conforme ela sai do provedor.
   *
   * O corpo é lido em pedaços e recortado por linha: um chunk de rede pode
   * partir um evento no meio, e concatenar o resto no começo do próximo é o que
   * impede um delta de sumir. O uso, quando o provedor o manda, sai no evento
   * final — misturá-lo ao texto faria o acumulado do outro lado deixar de ser
   * a resposta.
   */
  async *generateStream(
    connection: Extract<ResolvedConnection, { available: true }>,
    request: ProviderRequest,
  ): AsyncGenerator<ProviderStreamEvent, void, void> {
    const { signal, dispose } = this.abortPlan(request);
    let promptTokens: number | null = null;
    let completionTokens: number | null = null;

    try {
      const response = await this.fetchImpl(`${connection.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
          ...(connection.apiKey ? { Authorization: `Bearer ${connection.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: request.model,
          messages: request.messages,
          stream: true,
          ...(typeof request.temperature === 'number' ? { temperature: request.temperature } : {}),
          ...(typeof request.maxTokens === 'number' ? { max_tokens: request.maxTokens } : {}),
          ...(request.json ? { response_format: { type: 'json_object' } } : {}),
        }),
        signal,
      });

      if (!response.ok) {
        throw failureFromStatus(response.status, await response.text().catch(() => ''));
      }
      if (!response.body) {
        throw new ProviderFailure('provider_error', 'o provedor não abriu o fluxo de resposta');
      }

      let buffer = '';
      let produced = false;

      for await (const pedaco of streamChunks(response.body)) {
        buffer += pedaco;
        let quebra = buffer.indexOf('\n');
        while (quebra !== -1) {
          const linha = buffer.slice(0, quebra).trim();
          buffer = buffer.slice(quebra + 1);
          quebra = buffer.indexOf('\n');

          if (!linha.startsWith('data:')) continue;
          const payload = linha.slice(5).trim();
          if (!payload || payload === STREAM_DONE) continue;

          let chunk: ChatCompletionChunk;
          try {
            chunk = JSON.parse(payload) as ChatCompletionChunk;
          } catch {
            continue;
          }

          if (Number.isFinite(chunk.usage?.prompt_tokens as number)) {
            promptTokens = chunk.usage!.prompt_tokens as number;
          }
          if (Number.isFinite(chunk.usage?.completion_tokens as number)) {
            completionTokens = chunk.usage!.completion_tokens as number;
          }

          const texto = chunk.choices?.[0]?.delta?.content;
          if (typeof texto === 'string' && texto.length > 0) {
            produced = true;
            yield { kind: 'delta', text: texto };
          }
        }
      }

      if (!produced) {
        throw new ProviderFailure('provider_error', 'o provedor devolveu resposta vazia');
      }

      yield { kind: 'completed', promptTokens, completionTokens };
    } catch (error) {
      throw this.asFailure(error, request);
    } finally {
      dispose();
    }
  }

  /**
   * O cancelamento desta chamada: o tempo limite e o pedido de fora, juntos.
   *
   * Os dois abortam o mesmo controlador porque a chamada ao provedor é uma só.
   * Ignorar o de fora deixaria a conexão aberta depois de o navegador ir
   * embora — e ela continua sendo cobrada e ocupando a GPU.
   */
  private abortPlan(request: ProviderRequest): { signal: AbortSignal; dispose: () => void } {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), request.timeoutMs);
    const external = request.signal;
    const forward = () => controller.abort();

    if (external) {
      if (external.aborted) controller.abort();
      else external.addEventListener('abort', forward, { once: true });
    }

    return {
      signal: controller.signal,
      dispose: () => {
        clearTimeout(timer);
        external?.removeEventListener('abort', forward);
      },
    };
  }

  private asFailure(error: unknown, request: ProviderRequest): ProviderFailure {
    if (error instanceof ProviderFailure) return error;
    if (error instanceof Error && error.name === 'AbortError') {
      return request.signal?.aborted
        ? new ProviderFailure('cancelled', 'a geração foi cancelada por quem pediu')
        : new ProviderFailure('timeout', `o provedor não respondeu em ${request.timeoutMs}ms`);
    }
    return new ProviderFailure(
      'unavailable',
      `não consegui falar com o provedor: ${error instanceof Error ? error.message : error}`,
    );
  }
}

/**
 * O corpo da resposta em pedaços de texto, venha ele como stream da web ou
 * como iterável do Node.
 *
 * As duas formas existem no mesmo processo — `fetch` do Node devolve uma, e o
 * teste injeta a outra — e tratar só uma delas quebraria num dos dois lados.
 */
async function* streamChunks(body: unknown): AsyncGenerator<string, void, void> {
  const decoder = new TextDecoder();

  const reader = (body as ReadableStream<Uint8Array>)?.getReader?.bind(body);
  if (reader) {
    const leitor = reader();
    try {
      for (;;) {
        const { done, value } = await leitor.read();
        if (done) break;
        if (value) yield decoder.decode(value, { stream: true });
      }
    } finally {
      leitor.releaseLock?.();
    }
    return;
  }

  for await (const pedaco of body as AsyncIterable<Uint8Array | string>) {
    yield typeof pedaco === 'string' ? pedaco : decoder.decode(pedaco, { stream: true });
  }
}
