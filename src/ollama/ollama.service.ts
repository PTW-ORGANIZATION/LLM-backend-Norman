import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface OllamaChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

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

  async embed(text: string): Promise<number[]> {
    const host = this.config.get<string>('ollama.host');
    const model = this.config.get<string>('ollama.embeddingModel');

    const response = await fetch(`${host}/api/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, prompt: text }),
    });

    if (!response.ok) {
      throw new Error(`Ollama /api/embeddings retornou ${response.status}`);
    }

    const data = (await response.json()) as { embedding: number[] };
    return data.embedding;
  }
}
