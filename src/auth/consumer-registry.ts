import { GENERIC_COUNTERPART, type GenerationFeature } from '../gateway/feature-registry';
import {
  NORMAN_CAPABILITIES,
  isInternalCapability,
  type InternalCapability,
} from './internal-capabilities';

export type ConsumerScopeKind = 'client' | 'person';

export interface ConsumerApplication {
  /** Identidade da aplicação que chama, para auditoria e para limitar o escopo. */
  name: string;
  token: string;
  /** As operações de geração que esta aplicação pode pedir. */
  features: string[];
  /** Os escopos de conhecimento que ela pode usar. */
  scopes: ConsumerScopeKind[];
  capabilities: InternalCapability[];
}

export type EnvSource = Record<string, string | undefined>;

/**
 * As operações vinculadas a cliente que o Norman pede.
 *
 * Cada uma tem um par genérico, e o Norman troca de uma para a outra sozinho
 * quando ainda não há cliente escolhido. Declarar só o lado vinculado é o
 * defeito que esta lista fecha: a conversa anterior à escolha do cliente chega
 * como `chat_generic` e era recusada com 403 numa sessão perfeitamente válida.
 */
const NORMAN_CLIENT_BOUND_FEATURES: GenerationFeature[] = [
  'chat',
  'chat_stream',
  'briefing_final',
  'document_briefing',
  'workflow_briefing',
  'workflow_briefing_stream',
];

/** As operações do Norman que já nascem sem vínculo com cliente. */
const NORMAN_STANDALONE_FEATURES: GenerationFeature[] = ['job_insights'];

/**
 * As operações do consumidor `norman`, derivadas do próprio registro.
 *
 * Derivadas, e não transcritas: o par genérico sai de `GENERIC_COUNTERPART`, que
 * é a mesma fonte que descreve os dois modos no registro de operações. Enquanto
 * as duas listas eram escritas à mão, acrescentar um par genérico no registro
 * não acrescentava a autorização, e o defeito só aparecia com os dois serviços
 * conversando de verdade.
 *
 * Isto não abre nada para outro consumidor: quem entra por `INTERNAL_CONSUMERS`
 * continua declarando as próprias operações, uma a uma.
 */
export const NORMAN_FEATURES: GenerationFeature[] = [
  ...NORMAN_CLIENT_BOUND_FEATURES.flatMap((feature) => {
    const generic = GENERIC_COUNTERPART[feature];
    return generic ? [feature, generic] : [feature];
  }),
  ...NORMAN_STANDALONE_FEATURES,
];

/**
 * As aplicações que podem falar com as rotas internas.
 *
 * O Norman vem do `INTERNAL_API_TOKEN` de sempre, com as operações do produto e
 * o escopo de cliente. Outras aplicações — Niprofe é o caso do PDF — entram por
 *
 */
export function resolveConsumers(source: EnvSource = process.env): ConsumerApplication[] {
  const consumers: ConsumerApplication[] = [];

  const normanToken = (source.INTERNAL_API_TOKEN || '').trim();
  if (normanToken) {
    consumers.push({
      name: 'norman',
      token: normanToken,
      features: NORMAN_FEATURES,
      scopes: ['client'],
      capabilities: NORMAN_CAPABILITIES,
    });
  }

  for (const entry of (source.INTERNAL_CONSUMERS || '').split(',')) {
    const parsed = parseConsumer(entry, source);
    if (parsed) consumers.push(parsed);
  }

  return consumers;
}

function parseConsumer(entry: string, source: EnvSource): ConsumerApplication | null {
  const parts = entry.split(':').map((part) => part.trim());
  if (parts.length < 3) return null;

  const [name, tokenEnv, features, scopes, capabilities] = parts;
  if (!/^[a-z0-9-]{1,64}$/.test(name || '')) return null;
  if (!/^[A-Z0-9_]{1,64}$/.test(tokenEnv || '')) return null;

  const token = (source[tokenEnv] || '').trim();
  if (!token) return null;

  const allowedFeatures = (features || '')
    .split('|')
    .map((feature) => feature.trim())
    .filter(Boolean);
  if (allowedFeatures.length === 0) return null;

  const allowedScopes = (scopes || 'person')
    .split('|')
    .map((scope) => scope.trim())
    .filter((scope): scope is ConsumerScopeKind => scope === 'client' || scope === 'person');

  return {
    name,
    token,
    features: allowedFeatures,
    scopes: allowedScopes.length > 0 ? allowedScopes : ['person'],
    capabilities: (capabilities || '')
      .split('|')
      .map((capability) => capability.trim())
      .filter(isInternalCapability),
  };
}

/**
 * A aplicação de um token, ou nulo.
 *
 * Compara em tempo constante e percorre a lista inteira, para o tempo de
 * resposta não dizer quantas aplicações existem nem qual token chegou perto.
 */
export function consumerForToken(
  received: string,
  consumers: ConsumerApplication[],
): ConsumerApplication | null {
  let found: ConsumerApplication | null = null;
  for (const consumer of consumers) {
    if (constantTimeEquals(received, consumer.token) && !found) found = consumer;
  }
  return found;
}

function constantTimeEquals(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}
