import type { RetrievedChunk } from '../documents/document-chunks.service';
import { CLIENT_SCOPE, SYSTEM_SCOPE } from '../documents/knowledge-scope';
import type { RetrievalBudget, RetrievalEvidence } from './retrieval-budget';

/**
 * O que cada camada trouxe, e o total depois da mesclagem.
 *
 * Os números por camada ficam separados de propósito: sem eles, uma camada que
 * voltou vazia e uma camada que não pôde ser consultada apareceriam iguais na
 * auditoria, e é justamente essa distinção que impede tratar indisponibilidade
 * como ausência.
 */
export interface LayeredEvidence extends RetrievalEvidence {
  layers: {
    client: RetrievalEvidence | null;
    system: RetrievalEvidence | null;
  };
  /**
   * Se a camada geral do sistema entrou nesta geração.
   *
   * Falso quando ela foi deliberadamente deixada de fora — revogação geral
   * pendente, por exemplo. Nesse caso o conhecimento do cliente continua
   * valendo, e a resposta e o registro dizem qual camada faltou.
   */
  systemAvailable: boolean;
}

export interface LayeredRetrieval {
  snippets: RetrievedChunk[];
  evidence: LayeredEvidence;
}

export interface MergeKnowledgeLayersInput {
  client: { snippets: RetrievedChunk[]; evidence: RetrievalEvidence } | null;
  system: { snippets: RetrievedChunk[]; evidence: RetrievalEvidence } | null;
  budget: RetrievalBudget;
  systemAvailable: boolean;
}

/**
 * Quantos lugares do orçamento ficam garantidos para o acervo geral.
 *
 * Dois, e nunca mais que metade do teto: o suficiente para uma regra geral
 * chegar à resposta, pouco o bastante para o acervo do próprio cliente seguir
 * ocupando a maior parte do contexto.
 */
const SYSTEM_RESERVE = 2;

function chunkIdentity(chunk: RetrievedChunk): string {
  return `${chunk.knowledgeScope}:${chunk.documentId}:${chunk.chunkIndex}`;
}

/**
 * A mesma fonte, vista pelas duas camadas.
 *
 * Um documento do acervo geral não tem cliente, e por isso jamais aparece nas
 * duas listas; o par arquivo + trecho é comparado de todo modo porque a origem
 * física pode coincidir depois de uma promoção, e citar duas vezes o mesmo
 * trecho gastaria o orçamento de contexto com repetição.
 */
function sourceIdentity(chunk: RetrievedChunk): string {
  return `${chunk.storagePath ?? chunk.documentId}:${chunk.chunkIndex}`;
}

/**
 * Junta as duas camadas com **precedência do cliente sobre o sistema**.
 *
 * A ordem não é decorativa: ela é a regra de conflito. O que o cliente declara
 * entra primeiro e ocupa o orçamento primeiro, então uma regra geral que
 * contradiga a regra do cliente é a que fica de fora quando o espaço acaba — e,
 * mesmo quando as duas cabem, o bloco do cliente vem antes e o cabeçalho diz
 * qual manda.
 *
 * Cada camada chega aqui **já** com o próprio limiar de evidência e o próprio
 * orçamento aplicados. Esta função não refaz filtro de relevância: ela ordena,
 * deduplica e respeita o teto conjunto.
 */
export function mergeKnowledgeLayers({
  client,
  system,
  budget,
  systemAvailable,
}: MergeKnowledgeLayersInput): LayeredRetrieval {
  const clientSnippets = client?.snippets ?? [];
  const systemSnippets = systemAvailable ? system?.snippets ?? [] : [];

  const snippets: RetrievedChunk[] = [];
  const seen = new Set<string>();
  const sources = new Set<string>();
  let chars = 0;

  function admitir(chunk: RetrievedChunk, teto: number): boolean {
    if (snippets.length >= teto) return false;
    if (seen.has(chunkIdentity(chunk))) return false;
    if (sources.has(sourceIdentity(chunk))) return false;
    const size = chunk.content.length;
    if (snippets.length > 0 && chars + size > budget.maxChars) return false;
    seen.add(chunkIdentity(chunk));
    sources.add(sourceIdentity(chunk));
    snippets.push(chunk);
    chars += size;
    return true;
  }

  // Cota mínima do acervo geral.
  //
  // Concatenar as camadas e cortar no teto fazia o cliente consumir o
  // orçamento inteiro — o teto da mesclagem é o mesmo do orçamento por camada,
  // então cinco trechos de cliente preenchiam os cinco lugares e o `break`
  // disparava antes do primeiro trecho geral. Na prática o acervo geral nunca
  // entrava em acervo de cliente povoado, e a resposta afirmava que a
  // informação não existia com o documento indexado e recuperado.
  //
  // Precedência do cliente continua sendo a regra de conflito: ele entra
  // primeiro e ocupa a maior parte. O que muda é que precedência deixa de
  // significar exclusão.
  const reservaGeral = Math.min(
    SYSTEM_RESERVE,
    systemSnippets.length,
    Math.floor(budget.maxSnippets / 2),
  );

  for (const chunk of clientSnippets) admitir(chunk, budget.maxSnippets - reservaGeral);
  for (const chunk of systemSnippets) admitir(chunk, budget.maxSnippets);
  // Sobra da reserva não usada volta para o cliente: reservar lugar para uma
  // camada que não tinha o que pôr desperdiçaria contexto.
  for (const chunk of clientSnippets) admitir(chunk, budget.maxSnippets);

  const clientEvidence = client?.evidence ?? null;
  const systemEvidence = systemAvailable ? system?.evidence ?? null : null;
  const layerEvidences = [clientEvidence, systemEvidence].filter(
    (evidence): evidence is RetrievalEvidence => Boolean(evidence),
  );

  const considered = layerEvidences.reduce((total, evidence) => total + evidence.considered, 0);
  const discardedByRelevance = layerEvidences.reduce(
    (total, evidence) => total + evidence.discardedByRelevance,
    0,
  );
  const admitted = clientSnippets.length + systemSnippets.length;
  const discardedByBudget =
    layerEvidences.reduce((total, evidence) => total + evidence.discardedByBudget, 0)
    + (admitted - snippets.length);

  const bestSimilarities = layerEvidences
    .map((evidence) => evidence.bestSimilarity)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));

  return {
    snippets,
    evidence: {
      considered,
      used: snippets.length,
      discardedByRelevance,
      discardedByBudget,
      bestSimilarity: bestSimilarities.length > 0 ? Math.max(...bestSimilarities) : null,
      sufficient: snippets.length > 0,
      budget,
      layers: { client: clientEvidence, system: systemEvidence },
      systemAvailable,
    },
  };
}

/** Como cada camada é apresentada ao modelo, com a precedência declarada. */
export const LAYER_LABEL: Record<string, string> = {
  [CLIENT_SCOPE]: 'cliente',
  [SYSTEM_SCOPE]: 'sistema',
};
