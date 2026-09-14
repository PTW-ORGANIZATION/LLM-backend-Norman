import { describe, expect, it } from 'vitest';

import { REGRAS_DA_REVISAO_DE_ARTE as REGRAS_DO_EXECUTOR, featureSpec } from '../src/gateway/feature-registry';
import { REGRAS_DA_REVISAO_DE_ARTE as REGRAS_DO_NORMAN } from '@norman/lib/proof-review-rules';

/**
 * As regras da revisão de arte, comparadas entre os dois serviços.
 *
 * A revisão roda por dois caminhos: pelo gateway, com o prompt privilegiado do
 * executor como mensagem de sistema, e pelo caminho legado, com a mensagem que
 * o Norman monta. Cada lado precisa das regras por inteiro — um não lê o outro
 * em produção —, e foi a divergência entre as duas cópias que produziu o
 * defeito que esta suíte existe para não deixar voltar: enquanto o executor
 * mandava "copie exatamente o texto com erro" e o Norman pedia a palavra, a
 * mensagem de sistema ganhou, e a tela recebeu um alfinete só, com a linha
 * inteira no lugar da palavra e duas correções somadas num campo que a
 * interface mostra como uma.
 *
 * A comparação é literal e nos dois sentidos. Regra acrescentada de um lado só
 * reprova aqui, que é o único lugar onde os dois textos se encontram.
 */
describe('as regras da revisão de arte nos dois serviços', () => {
  it('são as mesmas, frase a frase e na mesma ordem', () => {
    expect(REGRAS_DO_EXECUTOR).toEqual(REGRAS_DO_NORMAN);
  });

  it('chegam inteiras ao prompt privilegiado da operação', () => {
    const sistema = featureSpec('proof_review')!.systemPrompt;

    for (const regra of REGRAS_DO_EXECUTOR) {
      expect(sistema).toContain(regra);
    }
  });

  it('não deixaram para trás a instrução que pedia a linha inteira', () => {
    const sistema = featureSpec('proof_review')!.systemPrompt;

    expect(sistema).not.toContain('Copie exatamente o texto com erro');
    expect(REGRAS_DO_NORMAN.join('\n')).not.toContain('copie EXATAMENTE o texto com erro');
  });
});
