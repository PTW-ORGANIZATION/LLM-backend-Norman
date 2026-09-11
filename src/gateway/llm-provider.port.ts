import type { ResolvedConnection } from './provider-connection';

export interface ProviderCapabilities {
  streaming: boolean;
  structuredOutput: boolean;
  vision: boolean;
  cancellation: boolean;
}

export interface GenerationMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
  /**
   * Imagens que acompanham a mensagem, como URLs de dados.
   *
   * Vazio na imensa maioria das gerações. Quando vem preenchido, o adaptador
   * monta o conteúdo multimodal do protocolo; sem isso a imagem seria
   * descartada em silêncio, que é o defeito que este campo existe para
   * impedir.
   */
  images?: string[];
}

export interface ProviderRequest {
  model: string;
  messages: GenerationMessage[];
  temperature?: number;
  maxTokens?: number;
  json?: boolean;
  timeoutMs: number;
  /**
   * Cancelamento vindo de fora. Abortá-lo encerra a chamada ao provedor, e não
   * só a leitura dela: uma conexão deixada aberta continua sendo cobrada e
   * continua ocupando a GPU depois de o navegador ter ido embora.
   */
  signal?: AbortSignal;
}

export interface ProviderResponse {
  text: string;
  promptTokens: number | null;
  completionTokens: number | null;
}

/**
 * Por que uma tentativa falhou.
 *
 * A classificação decide se o fallback pode acontecer, e por isso ela é parte do
 * contrato do adapter, não uma inspeção de mensagem de erro feita depois. Erro
 * de autorização, de payload e de configuração NUNCA autorizam trocar de
 * provedor: trocar não corrige nenhum dos três e espalha o pedido inválido.
 */
export type ProviderFailureKind =
  | 'unavailable'
  | 'timeout'
  | 'rate_limited'
  | 'provider_error'
  | 'authorization'
  | 'invalid_request'
  | 'misconfigured'
  | 'cancelled';

export class ProviderFailure extends Error {
  constructor(
    readonly kind: ProviderFailureKind,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ProviderFailure';
  }
}

export const FALLBACK_ELIGIBLE_KINDS: ProviderFailureKind[] = [
  'unavailable',
  'timeout',
  'rate_limited',
  'provider_error',
];

/**
 * Um pedaço de texto recém-produzido pelo provedor.
 *
 * O uso vem separado, no fim, porque ele não é texto: misturar contagem de
 * tokens no fluxo faria o acumulado do outro lado deixar de ser a resposta.
 */
export interface ProviderStreamDelta {
  kind: 'delta';
  text: string;
}

export interface ProviderStreamCompleted {
  kind: 'completed';
  promptTokens: number | null;
  completionTokens: number | null;
}

export type ProviderStreamEvent = ProviderStreamDelta | ProviderStreamCompleted;

export interface LlmProvider {
  readonly protocol: string;
  capabilities(): ProviderCapabilities;
  generate(
    connection: Extract<ResolvedConnection, { available: true }>,
    request: ProviderRequest,
  ): Promise<ProviderResponse>;
  /**
   * A mesma geração, entregue conforme sai do provedor.
   *
   * Existe como método próprio, e não como uma flag de `generate`, porque o
   * erro depois do primeiro pedaço não é o mesmo erro de antes dele: quem
   * consome precisa saber que já mandou texto para a tela.
   */
  generateStream(
    connection: Extract<ResolvedConnection, { available: true }>,
    request: ProviderRequest,
  ): AsyncGenerator<ProviderStreamEvent, void, void>;
}
