import { describe, expect, it } from 'vitest';

import { NORMAN_FEATURES } from '../src/auth/consumer-registry';
import { REGRAS_DA_REVISAO_DE_ARTE as REGRAS_DO_EXECUTOR, featureSpec } from '../src/gateway/feature-registry';
import { REGRAS_DA_REVISAO_DE_ARTE as REGRAS_DO_NORMAN } from '@norman/lib/proof-review-rules';
import { GATEWAY_FEATURES } from '@norman/modules/ai/llm-gateway.client';

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

/**
 * O que o Norman consegue pedir contra o que o executor autoriza.
 *
 * A autorização é operação por operação, e uma operação que falta na lista do
 * executor não explode: o pedido leva 403, o Norman registra um aviso e cai no
 * caminho legado. Foi o que aconteceu com `proof_review` desde que ela existe
 * — a tela dizia que a revisão de arte usava a conexão ativa, a auditoria não
 * registrava execução nenhuma, e tudo rodava no modelo local. Nenhuma das duas
 * suítes isoladas podia ver isso: uma tem a lista do cliente, a outra a do
 * servidor.
 */
describe('as operações que o Norman pede e as que o executor autoriza', () => {
  it('são o mesmo conjunto', () => {
    expect([...NORMAN_FEATURES].sort()).toEqual([...GATEWAY_FEATURES].sort());
  });

  it('todas têm prompt privilegiado declarado', () => {
    for (const feature of GATEWAY_FEATURES) {
      expect(featureSpec(feature)?.systemPrompt?.trim()).toBeTruthy();
    }
  });
});
