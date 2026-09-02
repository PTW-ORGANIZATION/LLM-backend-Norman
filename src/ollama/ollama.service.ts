import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface OllamaChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** Travada pela coluna `vector(768)` e pelo índice HNSW já construído. */
export const EMBEDDING_DIMENSIONS = 768;

// Lê um ReadableStream de NDJSON (uma linha = um JSON) sem corromper caracteres
// multi-byte partidos entre chunks e sem perder linhas partidas entre chunks.
async function* ndjsonLines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let newlineIndex = buffer.indexOf('\n');
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (line) yield line;
        newlineIndex = buffer.indexOf('\n');
      }
    }
    const rest = buffer.trim();
    if (rest) yield rest;
  } finally {
    reader.releaseLock();
  }
}

@Injectable()
export class OllamaService {
  constructor(private readonly config: ConfigService) {}

  async *chatStream(
    messages: OllamaChatMessage[],
    opts: { timeoutMs: number },
  ): AsyncGenerator<string> {
    const host = this.config.get<string>('ollama.host');
    const model = this.config.get<string>('ollama.model');

    const response = await fetch(`${host}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages, stream: true }),
      signal: AbortSignal.timeout(opts.timeoutMs),
    });

    if (!response.ok || !response.body) {
      throw new Error(`Ollama /api/chat retornou ${response.status}`);
    }

    for await (const line of ndjsonLines(response.body)) {
      const parsed = JSON.parse(line);
      if (parsed.message?.content) {
        yield parsed.message.content as string;
      }
    }
  }

  /** O nome do modelo de texto configurado, que é o que identifica quem gerou uma nota. */
  get textModel(): string {
    return this.config.get<string>('ollama.model') as string;
  }

  /**
   * Uma resposta em JSON, presa ao schema entregue ao modelo.
   *
   * `temperature: 0` porque o mesmo documento tem que produzir a mesma nota — o
   * acervo é regerado por comparação, e resposta que muda a cada chamada faria
   * qualquer comparação mentir. O schema vai no `format` do Ollama, mas o
   * retorno **não** é confiável por isso: quem chama valida de novo.
   */
  async generateJson(input: {
    prompt: string;
    system?: string;
    schema: unknown;
    timeoutMs: number;
  }): Promise<unknown> {
    const host = this.config.get<string>('ollama.host');

    const response = await fetch(`${host}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.textModel,
        prompt: input.prompt,
        system: input.system,
        format: input.schema,
        stream: false,
        options: { temperature: 0 },
      }),
      signal: AbortSignal.timeout(input.timeoutMs),
    });

    if (!response.ok) {
      throw new Error(`Ollama /api/generate retornou ${response.status}`);
    }

    const data = (await response.json()) as { response?: string };

    try {
      return JSON.parse(data.response ?? '');
    } catch {
      throw new Error('Ollama /api/generate não devolveu JSON analisável');
    }
  }

  async embed(text: string): Promise<number[]> {
    const [embedding] = await this.embedBatch([text]);
    return embedding;
  }

  /**
   * Os embeddings de vários textos numa chamada só, na mesma ordem da entrada.
   *
   * Recusa vetor que não tenha exatamente `EMBEDDING_DIMENSIONS` posições: a
   * coluna é `vector(768)` e o índice HNSW está construído nessa dimensão, então
   * trocar o modelo de embedding por um de outro tamanho tem que falhar aqui,
   * com o nome do modelo na mensagem, e não lá no INSERT.
   */
  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    const host = this.config.get<string>('ollama.host');
    const model = this.config.get<string>('ollama.embeddingModel');

    const response = await fetch(`${host}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, input: texts }),
    });

    if (!response.ok) {
      throw new Error(`Ollama /api/embed retornou ${response.status}`);
    }

    const data = (await response.json()) as { embeddings?: number[][] };
    const embeddings = data.embeddings ?? [];

    if (embeddings.length !== texts.length) {
      throw new Error(
        `Ollama /api/embed devolveu ${embeddings.length} vetores para ${texts.length} textos`,
      );
    }

    for (const embedding of embeddings) {
      if (embedding.length !== EMBEDDING_DIMENSIONS) {
        throw new Error(
          `Modelo de embedding "${model}" devolveu ${embedding.length} dimensões; ` +
            `a coluna e o índice HNSW exigem ${EMBEDDING_DIMENSIONS}`,
        );
      }
    }

    return embeddings;
  }
}
