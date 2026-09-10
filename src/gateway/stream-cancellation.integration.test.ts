import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InternalGenerationController } from './internal-generation.controller';
import { GenerationService } from './generation.service';
import { OpenAiChatAdapter } from './openai-chat.adapter';
import type { GenerateDto } from './generation.dto';

const CONEXAO = {
  key: 'ollama',
  label: 'Ollama',
  protocol: 'openai_chat' as const,
  available: true as const,
  baseUrl: 'http://provedor.invalido/v1',
  defaultModel: 'llama-local',
  allowedModels: ['llama-local'],
};

function pedido(): GenerateDto {
  return {
    contractVersion: 1,
    correlationId: 'corr-cancelamento',
    feature: 'chat_generic',
    actor: { userId: 'user-1' },
    activation: { activationId: 'act-1', connectionKey: 'ollama', connectionRevision: 1 },
    messages: [{ role: 'user', content: 'escreva devagar' }],
  } as GenerateDto;
}

/**
 * O corpo de um streaming que nunca termina sozinho.
 *
 * Entrega um delta e depois fica esperando: é o que reproduz a geração longa em
 * que o navegador vai embora antes do fim, e o único jeito de o `fetch` do
 * provedor sair dali é o `AbortSignal` chegar.
 */
function corpoInterminavel(signal: AbortSignal) {
  return {
    async *[Symbol.asyncIterator]() {
      yield new TextEncoder().encode(
        `data: ${JSON.stringify({ choices: [{ delta: { content: 'azul' } }] })}\n\n`,
      );
      await new Promise<void>((resolve, reject) => {
        if (signal.aborted) {
          reject(Object.assign(new Error('abortado'), { name: 'AbortError' }));
          return;
        }
        signal.addEventListener(
          'abort',
          () => reject(Object.assign(new Error('abortado'), { name: 'AbortError' })),
          { once: true },
        );
      });
    },
  };
}

/**
 * O executor completo atrás de um servidor HTTP de verdade.
 *
 * O teste anterior disparava o evento de fechamento na mão, o que provava só
 * que o ouvinte existia. Aqui a conexão é real: o cliente abre o fluxo, lê um
 * delta e fecha o socket, e o que se observa é o `signal` que chegou ao `fetch`
 * do provedor.
 */
async function subirExecutor(options: { concluir?: boolean } = {}) {
  const observado: { signal?: AbortSignal } = {};

  const fetchImpl = vi.fn(async (_url: unknown, init?: { signal?: AbortSignal }) => {
    observado.signal = init?.signal;
    if (options.concluir) {
      return {
        ok: true,
        status: 200,
        body: {
          async *[Symbol.asyncIterator]() {
            yield new TextEncoder().encode(
              `data: ${JSON.stringify({ choices: [{ delta: { content: 'azul' } }] })}\n\n`,
            );
            yield new TextEncoder().encode('data: [DONE]\n\n');
          },
        },
      } as any;
    }
    return { ok: true, status: 200, body: corpoInterminavel(init!.signal!) } as any;
  }) as unknown as typeof fetch;

  const adapter = new OpenAiChatAdapter(fetchImpl);

  // O serviço de geração é substituído pelo mínimo que o cancelamento exige:
  // o caminho em prova é o do sinal, do controller até o `fetch`, e subir banco
  // e registro de revisões aqui provaria outra coisa.
  const generationService = {
    async *generateStream(_dto: GenerateDto, signal?: AbortSignal) {
      const events = adapter.generateStream(CONEXAO, {
        model: 'llama-local',
        messages: [{ role: 'user', content: 'escreva devagar' }],
        json: false,
        timeoutMs: 30000,
        signal,
      });
      for await (const event of events) {
        if (event.kind === 'delta') yield { type: 'delta' as const, text: event.text };
      }
      yield {
        type: 'completed' as const,
        correlationId: 'corr-cancelamento',
        feature: 'chat_generic',
        usedConnectionKey: 'ollama',
        usedModel: 'llama-local',
        attempts: [],
        citations: [],
        evidence: null,
        knowledgeUnavailable: false,
        dossierState: 'absent' as const,
        promptTokens: null,
        completionTokens: null,
      };
    },
  } as unknown as GenerationService;

  const controller = new InternalGenerationController(
    generationService,
    { test: vi.fn() } as any,
    { describe: vi.fn(async () => []) } as any,
    adapter,
  );

  const server: Server = createServer((request, response) => {
    void controller.stream(pedido(), response as any, request as any);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const porta = typeof address === 'object' && address ? address.port : 0;

  return {
    url: `http://127.0.0.1:${porta}/`,
    observado,
    async parar() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function aguardar(condicao: () => boolean, prazoMs = 3000) {
  const limite = Date.now() + prazoMs;
  while (!condicao()) {
    if (Date.now() > limite) return false;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return true;
}

describe('cancelamento do streaming por conexão HTTP real', () => {
  let executor: Awaited<ReturnType<typeof subirExecutor>> | null = null;

  afterEach(async () => {
    await executor?.parar();
    executor = null;
  });

  it('o consumidor fechar a conexão aborta o fetch do provedor', async () => {
    executor = await subirExecutor();

    const abort = new AbortController();
    const response = await fetch(executor.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
      signal: abort.signal,
    });

    const leitor = response.body!.getReader();
    const decoder = new TextDecoder();
    let recebido = '';
    while (!recebido.includes('"delta"')) {
      const { done, value } = await leitor.read();
      if (done) break;
      recebido += decoder.decode(value, { stream: true });
    }
    expect(recebido).toContain('azul');

    // Fechar a conexão do lado do consumidor, como o navegador faz ao trocar de
    // aba: nada avisa o executor além do socket cair.
    abort.abort();
    await leitor.cancel().catch(() => undefined);

    expect(await aguardar(() => executor!.observado.signal?.aborted === true)).toBe(true);
    expect(executor.observado.signal?.aborted).toBe(true);
  }, 20000);

  // Em Node, `req` emite `close` quando o corpo da requisição terminou de ser
  // lido — o que acontece em toda chamada normal. Observar ali cancelava a
  // geração de todo mundo.
  it('requisição normal não é cancelada só porque o corpo terminou', async () => {
    executor = await subirExecutor({ concluir: true });

    const response = await fetch(executor.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mensagem: 'um corpo que termina antes da resposta' }),
    });
    const texto = await response.text();

    expect(texto).toContain('azul');
    expect(texto).toContain('"type":"completed"');
    expect(texto).not.toContain('"failureKind":"cancelled"');
    expect(executor.observado.signal?.aborted).toBe(false);
  }, 20000);

  it('conclusão normal não é registrada como cancelamento', async () => {
    executor = await subirExecutor({ concluir: true });

    const texto = await (await fetch(executor.url, { method: 'POST', body: '{}' })).text();
    // O `close` da resposta chega depois do `end()`; sem a trava de conclusão,
    // ele contaria como abandono do consumidor.
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(texto).toContain('"type":"completed"');
    expect(executor.observado.signal?.aborted).toBe(false);
  }, 20000);
});
