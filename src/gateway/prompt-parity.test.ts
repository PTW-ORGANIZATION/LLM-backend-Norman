import { describe, expect, it } from 'vitest';
import { FEATURE_SPECS, GENERATION_FEATURES } from './feature-registry';
import { renderInsightsPrompt, renderWorkflowBriefingPrompt } from './feature-payloads';

/**
 * O que os prompts do gateway precisam preservar do caminho legado.
 *
 * Não é a prosa: são os contratos que a tela e os testes do Norman leem — os
 * seis campos do briefing, o marcador de conclusão, o formato JSON de cada
 * operação e a regra de literalidade dos identificadores do acervo. Um prompt
 * reescrito "melhor" que perca qualquer um deles muda a conversa que está em
 * produção.
 */
describe('paridade dos prompts do gateway', () => {
  const chat = FEATURE_SPECS.chat.systemPrompt;
  const briefing = FEATURE_SPECS.briefing_final.systemPrompt;

  it('a conversa mantém os seis campos do briefing, na ordem do produto', () => {
    for (const campo of [
      '1. Objetivo principal',
      '2. Contexto e problema',
      '3. Publico-alvo/persona',
      '4. Mensagem-chave',
      '5. Identidade visual/tom',
      '6. Canais e taticas',
    ]) {
      expect(chat).toContain(campo);
    }
  });

  it('o marcador de conclusão continua sendo o que a tela lê', () => {
    expect(chat).toContain('BRIEFING_READY:');
  });

  it('a condução preserva o limite de duas perguntas por vez', () => {
    expect(chat).toContain('pergunte no maximo 2 por vez');
    expect(chat).toContain('Nao marque o briefing como pronto');
  });

  // Regressão Selenita: pedir a frase-chave devolve o código literal, e não o
  // nome da iniciativa citado ao lado dele.
  it('a regra de literalidade dos códigos do acervo continua no prompt', () => {
    expect(chat).toContain('Codigos e frases literais');
    expect(chat).toContain('sem substituir pelo nome da iniciativa');
    expect(chat).toContain('Outros nomes citados');
  });

  it('o briefing final declara o JSON com os seis campos exatos', () => {
    expect(briefing).toContain(
      '{"objective":"...","context":"...","target":"...","message":"...","visual":"...","channels":"..."}',
    );
    expect(briefing).toContain('Preencha TODOS os 6 campos');
  });

  it('o briefing de documento usa o mesmo contrato do briefing final', () => {
    expect(FEATURE_SPECS.document_briefing.systemPrompt).toBe(briefing);
  });

  it('a conversa em streaming usa o mesmo prompt da conversa', () => {
    expect(FEATURE_SPECS.chat_stream.systemPrompt).toBe(chat);
  });

  it('toda operação vinculada a cliente carrega as regras de isolamento', () => {
    for (const feature of GENERATION_FEATURES) {
      if (FEATURE_SPECS[feature].clientBinding !== 'required') continue;
      expect(FEATURE_SPECS[feature].systemPrompt).toContain('Não use conhecimento de outro cliente');
    }
  });

  // O modo genérico não pode calar sobre o acervo: sem dizer que não há
  // nenhum, o modelo trata a ausência de contexto como ausência de informação
  // e afirma o que não sabe.
  it('toda operação genérica declara que não há acervo de cliente', () => {
    for (const feature of GENERATION_FEATURES) {
      if (FEATURE_SPECS[feature].clientBinding !== 'none') continue;
      if (feature === 'job_insights') continue;
      expect(FEATURE_SPECS[feature].systemPrompt).toContain('Não há acervo de cliente nesta conversa');
    }
  });

  it('nenhuma operação genérica promete acervo que ela não consulta', () => {
    for (const feature of GENERATION_FEATURES) {
      if (FEATURE_SPECS[feature].clientBinding !== 'none') continue;
      expect(FEATURE_SPECS[feature].usesClientKnowledge).toBe(false);
    }
  });

  it('a temperatura e o teto de saída são os praticados em cada operação', () => {
    expect(FEATURE_SPECS.chat.defaults).toEqual({ temperature: 0.7, maxTokens: 1024 });
    expect(FEATURE_SPECS.briefing_final.defaults).toEqual({ temperature: 0.7, maxTokens: 2048 });
    expect(FEATURE_SPECS.workflow_briefing.defaults).toEqual({ temperature: 0.3, maxTokens: 1400 });
    expect(FEATURE_SPECS.job_insights.defaults).toEqual({ temperature: 0.6, maxTokens: 4096 });
  });
});

describe('prompt do briefing de entregável', () => {
  const payload = {
    deliverableType: 'Post',
    questions: ['  Qual o objetivo?  ', 'Qual o público?', '   '],
    existingAnswers: { 'Qual o objetivo?': ' vender ' },
  };

  it('lista as perguntas numeradas e o estado de cada resposta', () => {
    const prompt = renderWorkflowBriefingPrompt(payload);

    expect(prompt).toContain('1. Qual o objetivo?');
    expect(prompt).toContain('2. Qual o público?');
    expect(prompt).toContain('- Qual o objetivo?: vender');
    expect(prompt).toContain('- Qual o público?: [sem resposta]');
  });

  it('pergunta em branco não vira item da lista', () => {
    expect(renderWorkflowBriefingPrompt(payload)).not.toContain('3. ');
  });

  it('declara o entregável e o formato JSON de saída', () => {
    const prompt = renderWorkflowBriefingPrompt(payload);

    expect(prompt).toContain('briefing do entregavel "Post"');
    expect(prompt).toContain('"missingQuestions"');
    expect(prompt).toContain('"ready": false');
  });

  it('entregável não informado não deixa o prompt com um buraco', () => {
    expect(renderWorkflowBriefingPrompt({ questions: ['Qual o objetivo?'] }))
      .toContain('briefing do entregavel "Workflow"');
  });

  it('o mesmo pedido produz o mesmo prompt', () => {
    expect(renderWorkflowBriefingPrompt(payload)).toBe(renderWorkflowBriefingPrompt(payload));
  });
});

describe('prompt de insights', () => {
  it('leva os seis campos do briefing e as categorias obrigatórias', () => {
    const prompt = renderInsightsPrompt({
      objective: 'Lançar',
      context: 'c',
      target: 't',
      message: 'ORQUIDEA CROMADA 47',
      visual: 'v',
      channels: 'ch',
    });

    expect(prompt).toContain('- Objetivo: Lançar');
    expect(prompt).toContain('- Mensagem-chave: ORQUIDEA CROMADA 47');
    expect(prompt).toContain('Categorias obrigatorias: audience, engagement, channel, creative, risk.');
    expect(prompt).toContain('exatamente 5 insights');
  });

  it('campo ausente vira vazio, e não a palavra undefined', () => {
    expect(renderInsightsPrompt({})).not.toContain('undefined');
  });
});
