import { ConfigService } from '@nestjs/config';
import { describe, expect, it, vi } from 'vitest';
import { OllamaService } from '../ollama/ollama.service';
import { buildDocumentSummaryPrompt, NoteGenerationService } from './note-generation.service';
import { InvalidNoteContentError } from './note-content';

const REQUEST = {
  filename: 'brand-guide.pdf',
  scopePath: 'Vitalis/01_Brand',
  excerpt: 'O tom de voz da Vitalis é direto e sem jargão.',
};

function buildService(answer: unknown) {
  const config = { get: (_key: string, fallback?: unknown) => fallback } as unknown as ConfigService;
  const generateJson = vi.fn(
    async (_input: Parameters<OllamaService['generateJson']>[0]) => answer,
  );
  const ollama = {
    get textModel() {
      return 'llama3.1:8b-instruct-q4_0';
    },
    generateJson,
  } as unknown as OllamaService;

  return { service: new NoteGenerationService(config, ollama), generateJson };
}

describe('buildDocumentSummaryPrompt', () => {
  it('leva o nome do arquivo, a pasta e o trecho', () => {
    const prompt = buildDocumentSummaryPrompt(REQUEST);

    expect(prompt).toContain('brand-guide.pdf');
    expect(prompt).toContain('Vitalis/01_Brand');
    expect(prompt).toContain('O tom de voz da Vitalis é direto e sem jargão.');
  });
});

describe('NoteGenerationService.summarizeDocument', () => {
  it('devolve a nota validada', async () => {
    const { service, generateJson } = buildService({
      titulo: 'Brand guide',
      tipo: 'brand guide',
      idioma: 'pt',
      resumo: 'Define o tom de voz.',
      topicos: ['tom de voz'],
      entidades: ['Vitalis'],
    });

    const note = await service.summarizeDocument(REQUEST);

    expect(note.resumo).toBe('Define o tom de voz.');
    expect(generateJson).toHaveBeenCalledOnce();
  });

  it('exige o schema no pedido ao modelo', async () => {
    const { service, generateJson } = buildService({ resumo: 'algo' });

    await service.summarizeDocument(REQUEST);

    expect(generateJson.mock.calls[0][0]).toMatchObject({
      schema: { required: ['titulo', 'tipo', 'idioma', 'resumo', 'topicos', 'entidades', 'identificadores'] },
    });
  });

  it('recusa o que o modelo devolveu fora do formato, mesmo com schema', async () => {
    const { service } = buildService({ observacao: 'não achei nada' });

    await expect(service.summarizeDocument(REQUEST)).rejects.toThrow(InvalidNoteContentError);
  });

  it('o modelo que assina a nota é o de texto configurado', () => {
    expect(buildService({}).service.model).toBe('llama3.1:8b-instruct-q4_0');
  });
});
