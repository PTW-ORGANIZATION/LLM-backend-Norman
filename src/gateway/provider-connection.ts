export type ProviderProtocol = 'openai_chat';

export interface ProviderSpec {
  key: string;
  label: string;
  protocol: ProviderProtocol;
  baseUrlEnv: string;
  apiKeyEnv: string;
  modelEnv: string;
  allowedModelsEnv: string;
  defaultBaseUrl: string | null;
  defaultModel: string | null;
  requiresApiKey: boolean;
}

/**
 * As conexões que este backend sabe resolver, por chave.
 *
 * São duas: o Ollama, que roda na própria máquina, e o Grok. A OpenAI saiu —
 * não há conta dela, e uma conexão provisionável que ninguém pode usar é uma
 * escolha a mais na tela que só rende erro na hora de ativar. O protocolo
 * `openai_chat` continua: é o formato de fio que as duas falam, e não a
 * empresa.
 *
 * A lista é a allowlist: o contrato interno manda uma chave, nunca uma URL nem
 * um segredo, e o que não está aqui não existe. Cada conexão lê a própria
 * variável de ambiente, e nada atravessa de uma para outra — chave de um
 * provedor enviada ao endpoint de outro é vazamento de credencial.
 *
 * `defaultModel` só existe onde há um nome estável para assumir. Onde o
 * catálogo do provedor muda, a ausência faz a conexão aparecer como
 * indisponível apontando a variável que falta, em vez de falhar no provedor.
 */
export const PROVIDER_SPECS: Record<string, ProviderSpec> = {
  ollama: {
    key: 'ollama',
    label: 'Ollama',
    protocol: 'openai_chat',
    baseUrlEnv: 'OLLAMA_OPENAI_BASE_URL',
    apiKeyEnv: 'OLLAMA_API_KEY',
    modelEnv: 'OLLAMA_MODEL',
    allowedModelsEnv: 'OLLAMA_ALLOWED_MODELS',
    defaultBaseUrl: 'http://127.0.0.1:11434/v1',
    defaultModel: 'llama3.1:8b-instruct-q4_0',
    requiresApiKey: false,
  },
  grok: {
    key: 'grok',
    label: 'Grok (xAI)',
    protocol: 'openai_chat',
    baseUrlEnv: 'GROK_BASE_URL',
    apiKeyEnv: 'GROK_API_KEY',
    modelEnv: 'GROK_MODEL',
    allowedModelsEnv: 'GROK_ALLOWED_MODELS',
    defaultBaseUrl: 'https://api.x.ai/v1',
    defaultModel: null,
    requiresApiKey: true,
  },
};

export const PROVIDER_KEYS = Object.keys(PROVIDER_SPECS);

export type ResolvedConnection =
  | {
      key: string;
      label: string;
      protocol: ProviderProtocol;
      available: true;
      baseUrl: string;
      apiKey?: string;
      defaultModel: string;
      allowedModels: string[];
    }
  | {
      key: string;
      label: string;
      protocol: ProviderProtocol;
      available: false;
      reason: string;
    };

export type EnvSource = Record<string, string | undefined>;

/**
 * Valida a URL base de uma conexão provisionada.
 *
 * Recusa em vez de cair para o padrão de outro provedor, e recusa credencial
 * embutida na URL: `https://chave@host` entregaria o segredo em qualquer log
 * que registrasse o destino.
 */
export function validateBaseUrl(value: string): { ok: true; url: string } | { ok: false; reason: string } {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return { ok: false, reason: 'a URL base não é uma URL válida' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, reason: `protocolo não suportado na URL base: ${parsed.protocol}` };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, reason: 'a URL base não pode carregar credencial embutida' };
  }
  if (parsed.search || parsed.hash) {
    return { ok: false, reason: 'a URL base não pode carregar query nem fragmento' };
  }
  return { ok: true, url: value.replace(/\/+$/, '') };
}

function allowedModelsOf(spec: ProviderSpec, source: EnvSource, defaultModel: string): string[] {
  const configured = (source[spec.allowedModelsEnv] || '')
    .split(',')
    .map((model) => model.trim())
    .filter(Boolean);
  if (configured.length > 0) {
    return configured.includes(defaultModel) ? configured : [defaultModel, ...configured];
  }
  return [defaultModel];
}

/**
 * A variante do mesmo modelo que não raciocina, entre as que a conexão permite.
 *
 * Existe porque raciocínio é cobrado em tempo, e há operação que não precisa
 * dele: para achar `SELEBRAR` numa arte, o modelo gastava seis mil tokens
 * raciocinando e escrevia duzentos de resposta — sessenta segundos contra um e
 * sete da mesma família sem raciocínio, achando os mesmos três erros plantados.
 *
 * A escolha sai da allowlist, e só dela. Nada aqui inventa nome de modelo nem
 * amplia o que a conexão alcança: quem não quiser a variante basta não
 * permiti-la. E a busca é por forma, não por versão fixa — o sufixo da família
 * muda a cada modelo novo, e um nome cravado no código envelheceria calado.
 *
 * @returns o id da variante, ou `null` quando a conexão não permite nenhuma
 */
export function modeloSemRaciocinio(modelo: string, permitidos: readonly string[]): string | null {
  const pedido = String(modelo || '').trim();
  if (!pedido) return null;

  return permitidos.find((candidato) => (
    candidato !== pedido
    && candidato.startsWith(pedido)
    && candidato.endsWith('non-reasoning')
  )) ?? null;
}

/**
 * A conexão provisionada de uma chave, ou o motivo de ela não estar disponível.
 *
 * Nunca lança e nunca inventa: ausência de configuração aparece como
 * `available: false` com o nome da variável que falta, e não como sucesso.
 */
export function resolveConnection(key: string, source: EnvSource = process.env): ResolvedConnection {
  const spec = PROVIDER_SPECS[String(key || '').trim().toLowerCase()];
  if (!spec) {
    return {
      key: String(key || ''),
      label: String(key || ''),
      protocol: 'openai_chat',
      available: false,
      reason: `conexão "${key}" não está provisionada neste backend`,
    };
  }

  const identity = { key: spec.key, label: spec.label, protocol: spec.protocol };
  const configuredBaseUrl = (source[spec.baseUrlEnv] || '').trim();
  const rawBaseUrl = configuredBaseUrl || spec.defaultBaseUrl;
  if (!rawBaseUrl) {
    return { ...identity, available: false, reason: `defina ${spec.baseUrlEnv}` };
  }

  const baseUrl = validateBaseUrl(rawBaseUrl);
  if (!baseUrl.ok) {
    return { ...identity, available: false, reason: `${spec.baseUrlEnv}: ${baseUrl.reason}` };
  }

  const apiKey = (source[spec.apiKeyEnv] || '').trim() || undefined;
  if (spec.requiresApiKey && !apiKey) {
    return { ...identity, available: false, reason: `defina ${spec.apiKeyEnv}` };
  }

  const defaultModel = (source[spec.modelEnv] || '').trim() || spec.defaultModel || '';
  if (!defaultModel) {
    return { ...identity, available: false, reason: `defina ${spec.modelEnv}` };
  }

  return {
    ...identity,
    available: true,
    baseUrl: baseUrl.url,
    ...(apiKey ? { apiKey } : {}),
    defaultModel,
    allowedModels: allowedModelsOf(spec, source, defaultModel),
  };
}

export function listConnections(source: EnvSource = process.env): ResolvedConnection[] {
  return PROVIDER_KEYS.map((key) => resolveConnection(key, source));
}
