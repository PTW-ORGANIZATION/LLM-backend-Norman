import type { RetrievedChunk } from '../documents/document-chunks.service';

export interface RetrievalBudget {
  minSimilarity: number;
  maxChars: number;
  maxSnippets: number;
}

export interface RetrievalEvidence {
  considered: number;
  used: number;
  discardedByRelevance: number;
  discardedByBudget: number;
  bestSimilarity: number | null;
  sufficient: boolean;
  budget: RetrievalBudget;
}

export interface BudgetedRetrieval {
  snippets: RetrievedChunk[];
  evidence: RetrievalEvidence;
}

/**
 * Aplica o orçamento de contexto a um resultado de busca.
 *
 * Duas regras separadas, e a ordem importa. Primeiro relevância: trecho abaixo
 * do piso de similaridade não entra, porque o vizinho mais próximo de um
 * acervo pequeno é sempre "o mais próximo" mesmo quando não tem nada a ver com
 * a pergunta. Depois tamanho: o que sobra entra até o teto de caracteres, do
 * mais relevante para o menos.
 *
 * `sufficient` é o critério de evidência: falso quando nada sobreviveu. Ele não
 * afirma que a resposta é verdadeira — similaridade alta não prova verdade —,
 * apenas que havia trecho pertinente o bastante para citar.
 */
export function applyRetrievalBudget(
  chunks: RetrievedChunk[],
  budget: RetrievalBudget,
): BudgetedRetrieval {
  const ordered = [...chunks].sort((left, right) => right.similarity - left.similarity);
  const relevant = ordered.filter(
    (chunk) => Number.isFinite(chunk.similarity) && chunk.similarity >= budget.minSimilarity,
  );

  const snippets: RetrievedChunk[] = [];
  let chars = 0;
  for (const chunk of relevant) {
    if (snippets.length >= budget.maxSnippets) break;
    const size = chunk.content.length;
    if (snippets.length > 0 && chars + size > budget.maxChars) continue;
    snippets.push(chunk);
    chars += size;
  }

  return {
    snippets,
    evidence: {
      considered: chunks.length,
      used: snippets.length,
      discardedByRelevance: ordered.length - relevant.length,
      discardedByBudget: relevant.length - snippets.length,
      bestSimilarity: ordered.length > 0 && Number.isFinite(ordered[0].similarity)
        ? ordered[0].similarity
        : null,
      sufficient: snippets.length > 0,
      budget,
    },
  };
}
