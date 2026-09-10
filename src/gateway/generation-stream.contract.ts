import type { LayeredEvidence } from '../knowledge/layered-retrieval';
import type { GenerationAttemptReport, GenerationOutcome } from './generation.service';

export const GENERATION_STREAM_CONTRACT_VERSION = 1;

/**
 * Os eventos que o gateway emite numa geração em fluxo.
 *
 * `delta` carrega só texto, e nada além dele: o acumulado precisa ser
 * exatamente a resposta, e um metadado misturado no meio faria a tela mostrar
 * contagem de tokens no meio da frase.
 *
 * `completed` e `failed` são terminais e mutuamente exclusivos. `failed` diz se
 * já havia texto entregue — depois do primeiro pedaço não existe troca de
 * provedor, e a tela precisa distinguir "não começou" de "parou no meio".
 */
export interface GenerationStreamDelta {
  type: 'delta';
  text: string;
}

export interface GenerationStreamCompleted {
  type: 'completed';
  correlationId: string;
  feature: string;
  usedConnectionKey: string;
  /** A revisão que realmente executou — com fallback, não é a do corpo. */
  usedConnectionRevision: number;
  usedModel: string;
  attempts: GenerationAttemptReport[];
  citations: GenerationOutcome['citations'];
  evidence: LayeredEvidence | null;
  knowledgeUnavailable: boolean;
  /** Falso quando a camada geral do sistema ficou fora desta geração. */
  systemKnowledgeAvailable: boolean;
  dossierState: 'current' | 'stale' | 'absent';
  promptTokens: number | null;
  completionTokens: number | null;
}

export interface GenerationStreamFailed {
  type: 'failed';
  correlationId: string;
  feature: string;
  failureKind: string;
  reason: string;
  /** Se já havia texto entregue quando a falha aconteceu. */
  streamed: boolean;
  attempts: GenerationAttemptReport[];
}

export type GenerationStreamEvent =
  | GenerationStreamDelta
  | GenerationStreamCompleted
  | GenerationStreamFailed;
