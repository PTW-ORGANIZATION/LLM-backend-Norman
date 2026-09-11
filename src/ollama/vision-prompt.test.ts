import { describe, expect, it } from 'vitest';

import {
  SEM_TEXTO_SENTINELA,
  TRANSCRIPTION_PROMPT,
  declarouAusenciaDeTexto,
  removerSentinela,
} from './vision-prompt';

describe('TRANSCRIPTION_PROMPT', () => {
  it('pede a transcrição antes de oferecer qualquer saída', () => {
    const pedido = TRANSCRIPTION_PROMPT.indexOf('Escreva o que está escrito');
    const saida = TRANSCRIPTION_PROMPT.indexOf(SEM_TEXTO_SENTINELA);

    expect(pedido).toBeGreaterThanOrEqual(0);
    expect(saida).toBeGreaterThan(pedido);
  });

  it('condiciona a saída em vez de oferecê-la solta', () => {
    // O prompt anterior dizia "responda exatamente NENHUM_TEXTO" e o modelo
    // passou a responder isso para toda imagem, inclusive as legíveis. A
    // condição é o que torna a saída mais cara do que transcrever.
    expect(TRANSCRIPTION_PROMPT).toContain('Só se não houver nenhuma palavra escrita');
  });
});

describe('declarouAusenciaDeTexto', () => {
  it('reconhece a sentinela ao pé da letra', () => {
    expect(declarouAusenciaDeTexto(SEM_TEXTO_SENTINELA)).toBe(true);
  });

  it('reconhece as variações que o modelo inventa sozinho', () => {
    expect(declarouAusenciaDeTexto('**Imagem sem palavras escritas.**')).toBe(true);
    expect(declarouAusenciaDeTexto('Sem palavras escritas na imagem')).toBe(true);
    expect(declarouAusenciaDeTexto('Não há palavras escritas aqui')).toBe(true);
    expect(declarouAusenciaDeTexto('A imagem não contém texto')).toBe(true);
    expect(declarouAusenciaDeTexto('nao ha texto')).toBe(true);
  });

  it('ainda reconhece o marcador do prompt antigo', () => {
    expect(declarouAusenciaDeTexto('NENHUM_TEXTO')).toBe(true);
  });

  it('não confunde transcrição de verdade com ausência', () => {
    expect(declarouAusenciaDeTexto('CODIGO DE IMAGEM TOPAZIO 8841')).toBe(false);
    expect(declarouAusenciaDeTexto('')).toBe(false);
    expect(declarouAusenciaDeTexto(undefined as unknown as string)).toBe(false);
  });
});

describe('removerSentinela', () => {
  it('tira a declaração de ausência e deixa o resto', () => {
    expect(removerSentinela('IMAGEM SEM PALAVRAS ESCRITAS').trim()).toBe('');
    expect(removerSentinela('NENHUM_TEXTO').trim()).toBe('');
    expect(removerSentinela('linha útil').trim()).toBe('linha útil');
  });

  it('aguenta entrada ausente', () => {
    expect(removerSentinela(undefined as unknown as string)).toBe('');
  });
});
