import { describe, expect, it, vi } from 'vitest';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { OpenAiChatAdapter } from './openai-chat.adapter';
import { ProviderFailure, type ProviderRequest } from './llm-provider.port';

const CONEXAO = {
  key: 'openai' as const,
  label: 'OpenAI',
  protocol: 'openai_chat' as const,
  available: true as const,
  baseUrl: 'https://api.openai.com/v1',
  apiKey: 'segredo',
  defaultModel: 'gpt-x',
  allowedModels: ['gpt-x'],
};

const PEDIDO = {
  model: 'gpt-x',
  messages: [{ role: 'user' as const, content: 'oi' }],
  timeoutMs: 50,
};

@Module({ providers: [OpenAiChatAdapter] })
class AdapterTestModule {}

function respostaOk(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{ message: { content: 'resposta' } }],
      usage: { prompt_tokens: 12, completion_tokens: 3 },
      ...overrides,
    }),
    text: async () => '',
  } as unknown as Response;
}

describe('OpenAiChatAdapter', () => {
  it('inicializa pelo container do Nest sem exigir um provider para fetch', async () => {
    const module = await NestFactory.createApplicationContext(AdapterTestModule, { logger: false });

    expect(module.get(OpenAiChatAdapter)).toBeInstanceOf(OpenAiChatAdapter);
    await module.close();
  });

  it('declara as capacidades em vez de deixar quem chama supor', () => {
    expect(new OpenAiChatAdapter().capabilities()).toEqual({
      streaming: true,
      structuredOutput: true,
      vision: false,
      cancellation: true,
    });
  });

  it('chama o endpoint de chat com o modelo, a credencial e o uso de tokens de volta', async () => {
    const fetchImpl = vi.fn(async () => respostaOk());
    const adapter = new OpenAiChatAdapter(fetchImpl as unknown as typeof fetch);

    await expect(adapter.generate(CONEXAO, { ...PEDIDO, temperature: 0.3, maxTokens: 100, json: true }))
      .resolves.toEqual({ text: 'resposta', promptTokens: 12, completionTokens: 3 });

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer segredo');
    expect(JSON.parse(String(init.body))).toEqual({
      model: 'gpt-x',
      messages: [{ role: 'user', content: 'oi' }],
      temperature: 0.3,
      max_tokens: 100,
      response_format: { type: 'json_object' },
    });
  });

  it('conexão sem credencial não manda header de autorização', async () => {
    const fetchImpl = vi.fn(async () => respostaOk());
    const adapter = new OpenAiChatAdapter(fetchImpl as unknown as typeof fetch);
    const { apiKey, ...semChave } = CONEXAO;

    await adapter.generate(semChave, PEDIDO);

    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.headers).not.toHaveProperty('Authorization');
    expect(apiKey).toBe('segredo');
  });

  it('resposta sem uso de tokens devolve nulo em vez de zero', async () => {
    const fetchImpl = vi.fn(async () => respostaOk({ usage: undefined }));
    const adapter = new OpenAiChatAdapter(fetchImpl as unknown as typeof fetch);

    await expect(adapter.generate(CONEXAO, PEDIDO)).resolves.toMatchObject({
      promptTokens: null,
      completionTokens: null,
    });
  });

  it.each([
    [401, 'authorization'],
    [403, 'authorization'],
    [400, 'invalid_request'],
    [404, 'invalid_request'],
    [429, 'rate_limited'],
    [500, 'unavailable'],
    [503, 'unavailable'],
    [418, 'provider_error'],
  ])('classifica o status %d como %s', async (status, kind) => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status,
      json: async () => ({}),
      text: async () => 'detalhe',
    }) as unknown as Response);
    const adapter = new OpenAiChatAdapter(fetchImpl as unknown as typeof fetch);

    await expect(adapter.generate(CONEXAO, PEDIDO)).rejects.toMatchObject({ kind });
  });

  it('resposta vazia é erro do provedor, e não texto vazio aceito', async () => {
    const fetchImpl = vi.fn(async () => respostaOk({ choices: [{ message: { content: '   ' } }] }));
    const adapter = new OpenAiChatAdapter(fetchImpl as unknown as typeof fetch);

    await expect(adapter.generate(CONEXAO, PEDIDO)).rejects.toMatchObject({
      kind: 'provider_error',
    });
  });

  it('provedor que não responde no prazo vira timeout, não erro genérico', async () => {
    const fetchImpl = vi.fn((_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const erro = new Error('abortado');
          erro.name = 'AbortError';
          reject(erro);
        });
      }));
    const adapter = new OpenAiChatAdapter(fetchImpl as unknown as typeof fetch);

    await expect(adapter.generate(CONEXAO, { ...PEDIDO, timeoutMs: 10 })).rejects.toMatchObject({
      kind: 'timeout',
    });
  });

  it('falha de rede vira indisponibilidade', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('ECONNREFUSED'); });
    const adapter = new OpenAiChatAdapter(fetchImpl as unknown as typeof fetch);

    const erro = await adapter.generate(CONEXAO, PEDIDO).catch((error) => error);

    expect(erro).toBeInstanceOf(ProviderFailure);
    expect(erro.kind).toBe('unavailable');
  });
});

/**
 * Um corpo de resposta em pedaços, como o provedor o entrega.
 *
 * Os cortes ficam nos piores lugares de propósito: um chunk de rede pode partir
 * um evento no meio, e concatenar o resto no começo do próximo é o que impede
 * um delta de sumir.
 */
function corpoEmPedacos(pedacos: string[]) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const pedaco of pedacos) yield new TextEncoder().encode(pedaco);
    },
  };
}

function respostaStream(pedacos: string[], status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    body: corpoEmPedacos(pedacos),
    text: async () => '',
    json: async () => ({}),
  };
}

async function coletar(adapter: OpenAiChatAdapter, request?: Partial<ProviderRequest>) {
  const eventos: any[] = [];
  for await (const evento of adapter.generateStream(CONEXAO, { ...PEDIDO, ...request })) {
    eventos.push(evento);
  }
  return eventos;
}

describe('OpenAiChatAdapter.generateStream', () => {
  it('entrega mais de um delta antes de concluir', async () => {
    const fetchImpl = vi.fn(async () => respostaStream([
      'data: {"choices":[{"delta":{"content":"azul"}}]}\n',
      'data: {"choices":[{"delta":{"content":"-cobalto"}}]}\n',
      'data: [DONE]\n',
    ]));
    const adapter = new OpenAiChatAdapter(fetchImpl as unknown as typeof fetch);

    const eventos = await coletar(adapter);

    expect(eventos.filter((evento) => evento.kind === 'delta')).toEqual([
      { kind: 'delta', text: 'azul' },
      { kind: 'delta', text: '-cobalto' },
    ]);
    expect(eventos[eventos.length - 1].kind).toBe('completed');
  });

  it('o texto acumulado é igual ao conteúdo recebido, na ordem', async () => {
    const fetchImpl = vi.fn(async () => respostaStream([
      'data: {"choices":[{"delta":{"content":"a cor "}}]}\n',
      'data: {"choices":[{"delta":{"content":"da marca "}}]}\n',
      'data: {"choices":[{"delta":{"content":"é azul-cobalto"}}]}\n',
      'data: [DONE]\n',
    ]));
    const adapter = new OpenAiChatAdapter(fetchImpl as unknown as typeof fetch);

    const eventos = await coletar(adapter);

    const acumulado = eventos
      .filter((evento) => evento.kind === 'delta')
      .map((evento) => evento.text)
      .join('');
    expect(acumulado).toBe('a cor da marca é azul-cobalto');
  });

  it('evento partido entre dois pedaços de rede não perde delta', async () => {
    const fetchImpl = vi.fn(async () => respostaStream([
      'data: {"choices":[{"delta":{"cont',
      'ent":"azul"}}]}\ndata: {"choices":[{"delta":{"content":"-cobalto"}}]}\n',
      'data: [DONE]\n',
    ]));
    const adapter = new OpenAiChatAdapter(fetchImpl as unknown as typeof fetch);

    const eventos = await coletar(adapter);

    expect(eventos.filter((evento) => evento.kind === 'delta').map((evento) => evento.text))
      .toEqual(['azul', '-cobalto']);
  });

  it('o uso sai no evento final, e não misturado ao texto', async () => {
    const fetchImpl = vi.fn(async () => respostaStream([
      'data: {"choices":[{"delta":{"content":"ok"}}]}\n',
      'data: {"choices":[],"usage":{"prompt_tokens":11,"completion_tokens":3}}\n',
      'data: [DONE]\n',
    ]));
    const adapter = new OpenAiChatAdapter(fetchImpl as unknown as typeof fetch);

    const eventos = await coletar(adapter);

    expect(eventos[eventos.length - 1]).toEqual({
      kind: 'completed',
      promptTokens: 11,
      completionTokens: 3,
    });
    expect(eventos.filter((evento) => evento.kind === 'delta')).toHaveLength(1);
  });

  it('pede o fluxo ao provedor, e não a resposta inteira', async () => {
    const fetchImpl = vi.fn(async () => respostaStream(['data: {"choices":[{"delta":{"content":"ok"}}]}\n']));
    const adapter = new OpenAiChatAdapter(fetchImpl as unknown as typeof fetch);

    await coletar(adapter);

    expect(JSON.parse((fetchImpl.mock.calls[0] as any)[1].body).stream).toBe(true);
  });

  it('fluxo sem nenhum delta é falha, e não sucesso vazio', async () => {
    const fetchImpl = vi.fn(async () => respostaStream(['data: [DONE]\n']));
    const adapter = new OpenAiChatAdapter(fetchImpl as unknown as typeof fetch);

    await expect(coletar(adapter)).rejects.toMatchObject({ kind: 'provider_error' });
  });

  it('erro antes do primeiro delta chega classificado', async () => {
    const fetchImpl = vi.fn(async () => respostaStream([], 429));
    const adapter = new OpenAiChatAdapter(fetchImpl as unknown as typeof fetch);

    await expect(coletar(adapter)).rejects.toMatchObject({ kind: 'rate_limited' });
  });

  // Conexão deixada aberta continua sendo cobrada e continua ocupando a GPU
  // depois de o navegador ir embora.
  it('cancelar encerra a chamada ao provedor', async () => {
    const controller = new AbortController();
    let recebido: AbortSignal | undefined;
    const fetchImpl = vi.fn(async (_url: string, init: any) => {
      recebido = init.signal;
      return respostaStream(['data: {"choices":[{"delta":{"content":"azul"}}]}\n']);
    });
    const adapter = new OpenAiChatAdapter(fetchImpl as unknown as typeof fetch);

    const iterador = adapter.generateStream(CONEXAO, { ...PEDIDO, signal: controller.signal });
    await iterador.next();
    controller.abort();

    expect(recebido?.aborted).toBe(true);
    await iterador.return(undefined as never);
  });

  it('cancelamento vira falha própria, e não tempo esgotado', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchImpl = vi.fn(async (_url: string, init: any) => {
      const erro = new Error('The operation was aborted');
      erro.name = 'AbortError';
      if (init.signal.aborted) throw erro;
      return respostaStream([]);
    });
    const adapter = new OpenAiChatAdapter(fetchImpl as unknown as typeof fetch);

    await expect(coletar(adapter, { signal: controller.signal }))
      .rejects.toMatchObject({ kind: 'cancelled' });
  });

  it('sem pedido de cancelamento, aborto é tempo esgotado', async () => {
    const fetchImpl = vi.fn(async () => {
      const erro = new Error('The operation was aborted');
      erro.name = 'AbortError';
      throw erro;
    });
    const adapter = new OpenAiChatAdapter(fetchImpl as unknown as typeof fetch);

    await expect(coletar(adapter)).rejects.toMatchObject({ kind: 'timeout' });
  });
});
