/**
 * Os dados estruturados que algumas operações precisam para o executor montar
 * o prompt privilegiado delas.
 *
 * Estruturados, e não em texto: o briefing de entregável tem prompt de sistema
 * dinâmico — ele lista as perguntas obrigatórias e o estado das respostas — e
 * aceitar esse texto pronto de quem chama seria aceitar prompt privilegiado
 * vindo de fora, que é exatamente o que o contrato não permite.
 */
export interface WorkflowBriefingPayload {
  deliverableType?: string;
  questions: string[];
  existingAnswers?: Record<string, string>;
}

export interface BriefingFrameworkPayload {
  objective?: string;
  context?: string;
  target?: string;
  message?: string;
  visual?: string;
  channels?: string;
}

export interface NormalizedWorkflowBriefing {
  questions: string[];
  answers: Record<string, string>;
}

export function normalizeWorkflowBriefing(
  payload: WorkflowBriefingPayload,
): NormalizedWorkflowBriefing {
  const questions = (payload.questions ?? [])
    .map((question) => String(question || '').trim())
    .filter(Boolean);
  const answers = Object.fromEntries(
    questions.map((question) => [
      question,
      String(payload.existingAnswers?.[question] || '').trim(),
    ]),
  );
  return { questions, answers };
}

/**
 * O prompt de sistema do briefing de entregável, com as perguntas e o estado.
 *
 * O texto é o do caminho legado, incluindo a ausência de acentuação e o formato
 * de saída: `reply`, `answers`, `ready` e `missingQuestions` são lidos campo a
 * campo do outro lado, e o `answers` é casado pela pergunta exata.
 */
export function renderWorkflowBriefingPrompt(payload: WorkflowBriefingPayload): string {
  const { questions, answers } = normalizeWorkflowBriefing(payload);
  const deliverableType = String(payload.deliverableType || '').trim() || 'Workflow';

  return `Voce e o NORMAN, assistente de briefing de workflow dentro do sistema Norman.
Seu papel e ajudar o usuario a completar o briefing do entregavel "${deliverableType}".

Voce deve trabalhar EXCLUSIVAMENTE com a lista de perguntas obrigatorias abaixo:
${questions.map((question, index) => `${index + 1}. ${question}`).join('\n')}

Estado atual das respostas:
${questions.map((question) => `- ${question}: ${answers[question] || '[sem resposta]'}`).join('\n')}

Regras obrigatorias:
- Considere apenas as perguntas acima.
- Extraia respostas do texto do usuario quando elas estiverem claras e objetivas.
- Preserve respostas ja preenchidas, a menos que o usuario complemente ou corrija explicitamente.
- Se faltarem respostas, liste de forma clara TODAS as perguntas ainda pendentes.
- Se todas as perguntas estiverem respondidas com clareza suficiente, marque ready=true.
- Nao invente informacoes ausentes.
- Responda em Portugues do Brasil.

Retorne APENAS JSON valido neste formato:
{
  "reply": "mensagem curta para o usuario",
  "answers": {
    "Pergunta exata 1": "resposta ou string vazia",
    "Pergunta exata 2": "resposta ou string vazia"
  },
  "ready": false,
  "missingQuestions": ["Pergunta exata ainda faltante"]
}`;
}

/** O pedido de insights sobre um briefing já estruturado. */
export function renderInsightsPrompt(framework: BriefingFrameworkPayload): string {
  return `Com base no briefing estruturado abaixo, gere exatamente 5 insights estrategicos especificos e acionaveis.

BRIEFING:
- Objetivo: ${framework.objective ?? ''}
- Contexto: ${framework.context ?? ''}
- Publico-alvo: ${framework.target ?? ''}
- Mensagem-chave: ${framework.message ?? ''}
- Identidade visual/tom: ${framework.visual ?? ''}
- Canais e taticas: ${framework.channels ?? ''}

Categorias obrigatorias: audience, engagement, channel, creative, risk.
Responda APENAS em JSON valido:
{
  "insights": [
    {
      "category": "audience|engagement|channel|creative|risk",
      "icon": "users|heart|share|lightbulb|alert",
      "title": "Titulo curto",
      "description": "Descricao com recomendacao acionavel",
      "impact": "high|medium|low"
    }
  ]
}`;
}
