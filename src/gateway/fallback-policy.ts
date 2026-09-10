import { FALLBACK_ELIGIBLE_KINDS, type ProviderFailureKind } from './llm-provider.port';

/**
 * A política de fallback como ela chega no contrato.
 *
 * `connectionRevision` e `model` não são opcionais quando a política está
 * ligada: o fallback aponta para a revisão **exata** que o administrador testou
 * e aprovou. Enquanto só a chave lógica atravessava, quem executava escolhia a
 * revisão habilitada mais nova — e uma revisão sincronizada minutos antes,
 * ainda sem teste, era exatamente a que entrava em uso na indisponibilidade.
 */
export interface FallbackPolicy {
  enabled: boolean;
  connectionKey: string | null;
  connectionRevision: number | null;
  model: string | null;
  allowedCauses: ProviderFailureKind[];
  maxAttempts: number;
}

/** Desligado por padrão: trocar de fornecedor manda dados a outro destino. */
export const FALLBACK_DISABLED: FallbackPolicy = {
  enabled: false,
  connectionKey: null,
  connectionRevision: null,
  model: null,
  allowedCauses: [],
  maxAttempts: 1,
};

export type FallbackDecision =
  | { allowed: true; connectionKey: string; connectionRevision: number; model: string }
  | { allowed: false; reason: string };

/**
 * Se a próxima tentativa pode ir para o provedor alternativo.
 *
 * A causa é a classificação que o adapter atribuiu, não a mensagem do erro.
 * Autorização, isolamento, payload inválido e configuração inválida não estão
 * entre as causas elegíveis nem quando o administrador as lista: trocar de
 * provedor não corrige nenhuma delas e só espalha o pedido inválido.
 *
 * Um stream já entregue nunca cai aqui — quem entregou byte ao usuário não
 * troca de provedor no meio nem concatena resposta de dois fornecedores.
 *
 * Política ligada sem revisão ou sem modelo é recusada em vez de aproximada: é o
 * caso de uma política antiga lida por um executor novo, e escolher a revisão
 * "mais parecida" ali é o defeito que esta forma fecha.
 */
export function decideFallback(input: {
  policy: FallbackPolicy;
  failure: ProviderFailureKind;
  attemptsSoFar: number;
  primaryKey: string;
  streamed: boolean;
}): FallbackDecision {
  const { policy, failure, attemptsSoFar, primaryKey, streamed } = input;

  if (!policy.enabled) return { allowed: false, reason: 'fallback desligado' };
  if (streamed) {
    return { allowed: false, reason: 'a resposta já começou a ser entregue' };
  }
  if (!policy.connectionKey) {
    return { allowed: false, reason: 'nenhum provedor alternativo configurado' };
  }
  if (policy.connectionKey === primaryKey) {
    return { allowed: false, reason: 'o provedor alternativo é o mesmo do principal' };
  }
  if (!Number.isInteger(policy.connectionRevision) || (policy.connectionRevision as number) < 0) {
    return {
      allowed: false,
      reason: 'a política de fallback não fixa a revisão aprovada do provedor alternativo',
    };
  }
  if (!String(policy.model || '').trim()) {
    return {
      allowed: false,
      reason: 'a política de fallback não fixa o modelo aprovado do provedor alternativo',
    };
  }
  if (!FALLBACK_ELIGIBLE_KINDS.includes(failure)) {
    return { allowed: false, reason: `a causa "${failure}" não autoriza troca de provedor` };
  }
  if (!policy.allowedCauses.includes(failure)) {
    return { allowed: false, reason: `a causa "${failure}" não está entre as autorizadas` };
  }
  if (attemptsSoFar >= policy.maxAttempts) {
    return { allowed: false, reason: 'limite de tentativas alcançado' };
  }

  return {
    allowed: true,
    connectionKey: policy.connectionKey,
    connectionRevision: policy.connectionRevision as number,
    model: String(policy.model).trim(),
  };
}
