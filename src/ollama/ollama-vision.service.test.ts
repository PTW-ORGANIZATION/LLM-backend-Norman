import { describe, expect, it } from 'vitest';
import { cleanTranscription } from './ollama-vision.service';

describe('cleanTranscription', () => {
  it('tira o negrito e os rótulos que o modelo acrescenta sozinho', () => {
    const raw = '**Título:**\nNorman contrato de marca página um\n\n**Imagem:**\n(Imagem de um documento)';
    expect(cleanTranscription(raw)).toBe('Norman contrato de marca página um');
  });

  it('devolve vazio quando o modelo sinaliza que não há texto', () => {
    expect(cleanTranscription('NENHUM_TEXTO')).toBe('');
    expect(cleanTranscription('  nenhum_texto  ')).toBe('');
  });

  it('preserva o texto real em várias linhas', () => {
    expect(cleanTranscription('primeira linha\nsegunda linha')).toBe('primeira linha\nsegunda linha');
  });

  it('remove cerca de código', () => {
    expect(cleanTranscription('```\ntexto do documento\n```')).toBe('texto do documento');
  });

  it('devolve vazio para resposta ausente', () => {
    expect(cleanTranscription('')).toBe('');
    expect(cleanTranscription('   ')).toBe('');
  });
});
