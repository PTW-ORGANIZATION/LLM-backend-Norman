import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

const TRANSCRIPTION_PROMPT = [
  'Transcreva literalmente todo o texto visível nesta imagem.',
  'Não descreva a imagem, não traduza e não resuma.',
  'Não adicione títulos, rótulos, marcadores nem comentários seus.',
  'Se não houver nenhum texto legível, responda exatamente NENHUM_TEXTO.',
].join(' ');

const NO_TEXT_SENTINEL = 'NENHUM_TEXTO';

/**
 * Tira do retorno do modelo o enfeite que ele insiste em acrescentar mesmo
 * proibido — negrito de markdown, rótulos como `Título:` e linhas de descrição
 * entre parênteses.
 *
 * Devolve string vazia quando o modelo sinalizou que não havia texto: página
 * sem texto precisa chegar vazia ao chamador para virar `failed`, e não virar
 * um chunk com a descrição do papel em branco.
 */
export function cleanTranscription(raw: string): string {
  const withoutSentinel = String(raw || '').replace(new RegExp(NO_TEXT_SENTINEL, 'gi'), '');

  const lines = withoutSentinel
    .replace(/\*\*/g, '')
    .replace(/^```[a-z]*\n?/gim, '')
    .replace(/```$/gm, '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => !/^(t[ií]tulo|imagem|texto|transcri[cç][aã]o|conte[uú]do)\s*:?\s*$/i.test(line))
    .filter((line) => !/^\((?:imagem|foto|figura)\b.*\)$/i.test(line));

  return lines.join('\n').trim();
}

@Injectable()
export class OllamaVisionService {
  constructor(private readonly config: ConfigService) {}

  /**
   * O texto visível de uma imagem, transcrito pelo modelo de visão.
   *
   * Devolve string vazia quando não há texto legível — nunca uma descrição da
   * imagem. Quem chama trata vazio como página sem conteúdo.
   */
  async transcribeImage(image: Buffer, opts: { timeoutMs: number }): Promise<string> {
    const host = this.config.get<string>('ollama.host');
    const model = this.config.get<string>('ollama.visionModel');

    const response = await fetch(`${host}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        prompt: TRANSCRIPTION_PROMPT,
        images: [image.toString('base64')],
        stream: false,
        options: { temperature: 0 },
      }),
      signal: AbortSignal.timeout(opts.timeoutMs),
    });

    if (!response.ok) {
      throw new Error(`Ollama /api/generate (visão) retornou ${response.status}`);
    }

    const data = (await response.json()) as { response?: string };
    return cleanTranscription(data.response ?? '');
  }
}
