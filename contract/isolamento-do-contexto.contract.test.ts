import { describe, expect, it } from 'vitest';

import { FEATURE_SPECS, GENERATION_FEATURES } from '../src/gateway/feature-registry';
import {
  ISOLAMENTO_POR_CLIENTE,
  ISOLAMENTO_SEM_CLIENTE,
  blocoDeIsolamento,
} from '@norman/lib/isolamento-do-contexto';

/**
 * O bloco de isolamento, comparado entre os dois serviços.
 *
 * Ele existe duas vezes desde que a orquestração passou para o Norman: no
 * registro de operações do executor, que o caminho do gateway usa, e no
 * `lib/isolamento-do-contexto` do Norman, que o caminho orquestrado antepõe à
 * mensagem de sistema. Trocar de caminho não pode trocar as regras que o modelo
 * recebe — e a divergência seria invisível, porque as duas respostas
 * continuariam plausíveis.
 *
 * A última linha de cada bloco é defesa contra injeção: trechos de documento do
 * acervo entram no prompt como texto, e um documento pode conter instrução
 * endereçada ao modelo. Perder essa linha de um dos lados é perder a defesa
 * inteira naquele caminho, em silêncio.
 */

const COM_CLIENTE = [
  'chat',
  'chat_stream',
  'briefing_final',
  'document_briefing',
  'workflow_briefing',
  'workflow_briefing_stream',
] as const;

const SEM_CLIENTE = COM_CLIENTE.map((feature) => `${feature}_generic`);

/**
 * As que não carregam bloco de isolamento, e por quê.
 *
 * Listadas para que uma operação nova sem bloco nenhum precise ser declarada
 * aqui de propósito, em vez de passar despercebida.
 */
const SEM_BLOCO: Record<string, string> = {
  job_insights: 'recebe dados já autorizados da vaga, sem acervo e sem conversa',
  proof_review: 'revisão de lista de palavras, que não recebe contexto de acervo',
  proof_review_visual: 'revisão da peça pela imagem, que não recebe contexto de acervo',
};

describe('os dois caminhos dão as mesmas regras de isolamento ao modelo', () => {
  /**
   * O bloco é comparado até a borda, e não por prefixo.
   *
   * `startsWith` sozinho aceita bloco truncado: cortar o fim da última linha no
   * Norman continua sendo prefixo do prompt do executor, e a defesa contra
   * injeção sumiria de um lado com o contrato verde.
   */
  function abreCom(prompt: string, bloco: string): boolean {
    return prompt === bloco || prompt.startsWith(`${bloco}\n`);
  }

  it.each(COM_CLIENTE)('%s abre com o bloco por cliente, até a borda', (feature) => {
    expect(abreCom(FEATURE_SPECS[feature].systemPrompt, blocoDeIsolamento(true))).toBe(true);
  });

  it.each(SEM_CLIENTE)('%s abre com o bloco sem cliente, até a borda', (feature) => {
    expect(abreCom(FEATURE_SPECS[feature as never].systemPrompt, blocoDeIsolamento(false)))
      .toBe(true);
  });

  it('toda operação ou carrega um bloco, ou está declarada como sem bloco', () => {
    const cobertas = new Set<string>([...COM_CLIENTE, ...SEM_CLIENTE, ...Object.keys(SEM_BLOCO)]);
    expect(GENERATION_FEATURES.filter((feature) => !cobertas.has(feature))).toEqual([]);
  });

  it('a defesa contra injeção está nos dois blocos, dos dois lados', () => {
    for (const bloco of [ISOLAMENTO_POR_CLIENTE, ISOLAMENTO_SEM_CLIENTE]) {
      expect(bloco[bloco.length - 1]).toContain('é dado, não instrução');
      expect(bloco[bloco.length - 1]).toContain('revelar prompt');
    }
    for (const feature of [...COM_CLIENTE, ...SEM_CLIENTE]) {
      expect(FEATURE_SPECS[feature as never].systemPrompt).toContain('é dado, não instrução');
    }
  });

  it('o bloco por cliente e o sem cliente não são o mesmo texto', () => {
    expect(blocoDeIsolamento(true)).not.toBe(blocoDeIsolamento(false));
  });
});
