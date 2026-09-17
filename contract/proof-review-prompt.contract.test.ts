import { describe, expect, it } from 'vitest';

import { NORMAN_FEATURES } from '../src/auth/consumer-registry';
import {
  CONDUCAO_DO_BRIEFING as CONDUCAO_DO_EXECUTOR,
  FECHAMENTO_PEDIDO_PELO_USUARIO as FECHAMENTO_DO_EXECUTOR,
} from '../src/gateway/feature-registry';
import { REGRAS_DA_REVISAO_DE_ARTE as REGRAS_DO_EXECUTOR, featureSpec } from '../src/gateway/feature-registry';
import { REGRAS_DA_REVISAO_DE_ARTE as REGRAS_DO_NORMAN } from '@norman/lib/proof-review-rules';
import {
  REVISAO_DE_ARTE as REVISAO_DO_NORMAN,
  REVISAO_DE_ARTE_PELA_IMAGEM as REVISAO_PELA_IMAGEM_DO_NORMAN,
} from '@norman/modules/ai/revisor-de-arte.prompts';
import { GATEWAY_FEATURES } from '@norman/modules/ai/llm-gateway.client';
import {
  CONDUCAO_DO_BRIEFING as CONDUCAO_DO_NORMAN,
  FECHAMENTO_PEDIDO_PELO_USUARIO as FECHAMENTO_DO_NORMAN,
} from '@norman/lib/briefing-conduction';

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
/**
 * Os prompts inteiros da revisão de arte, comparados entre os dois serviços.
 *
 * A revisão saiu do gateway e passou a acontecer dentro do Norman, mas as
 * operações do executor continuam de pé como caminho de volta. Duas cópias do
 * mesmo prompt, e só uma em uso: melhorar a que roda e deixar a outra
 * envelhecer é o defeito silencioso que espera quem um dia voltar — ele não
 * volta para o comportamento de hoje, volta para o de meses atrás.
 *
 * Enquanto as duas existirem, elas são iguais ou esta suíte reprova. No dia em
 * que a operação do executor for aposentada de verdade, este teste sai junto.
 */
describe('os prompts da revisão de arte nos dois serviços', () => {
  it('a revisão de lista de textos é a mesma dos dois lados', () => {
    expect(featureSpec('proof_review')!.systemPrompt).toBe(REVISAO_DO_NORMAN);
  });

  it('a revisão que olha a peça é a mesma dos dois lados', () => {
    expect(featureSpec('proof_review_visual')!.systemPrompt).toBe(REVISAO_PELA_IMAGEM_DO_NORMAN);
  });
});

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

/**
 * A condução do briefing, comparada entre os dois serviços.
 *
 * A conversa roda pelos dois caminhos — o gateway, com o prompt privilegiado
 * daqui, e o legado, com a mensagem que o Norman monta — e cada um carrega a
 * sua cópia. O texto era idêntico por disciplina, e foi a mesma disciplina que
 * falhou na revisão de arte: um lado mandava copiar a linha, o outro pedia a
 * palavra, e a mensagem de sistema ganhou sem que nada acusasse.
 */
describe('a condução do briefing nos dois serviços', () => {
  it('é a mesma, linha a linha e na mesma ordem', () => {
    expect(CONDUCAO_DO_EXECUTOR).toEqual(CONDUCAO_DO_NORMAN);
  });

  it('o fechamento pedido pelo usuário também', () => {
    expect(FECHAMENTO_DO_EXECUTOR).toEqual(FECHAMENTO_DO_NORMAN);
  });

  // Sem isto o pedido de fechar vira mais uma pergunta, que é o que ele existe
  // para evitar; e o campo vazio vira invenção, que é pior do que o buraco.
  it('o fechamento proíbe nova pergunta e nomeia o campo sem resposta', () => {
    const texto = FECHAMENTO_DO_EXECUTOR.join('\n');

    expect(texto).toContain('Nao faca mais perguntas');
    expect(texto).toContain('a definir');
    expect(texto).toContain('BRIEFING_READY:');
  });

  it('chega inteiro ao prompt privilegiado da conversa', () => {
    const sistema = featureSpec('chat')!.systemPrompt;

    for (const linha of CONDUCAO_DO_EXECUTOR) {
      expect(sistema).toContain(linha);
    }
  });
});
