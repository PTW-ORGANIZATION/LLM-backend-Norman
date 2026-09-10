import { describe, expect, it } from 'vitest';
import { applyRetrievalBudget } from './retrieval-budget';
import type { RetrievedChunk } from '../documents/document-chunks.service';

function chunk(overrides: Partial<RetrievedChunk> & { content: string; similarity: number }): RetrievedChunk {
  return {
    knowledgeScope: 'client',
    documentId: 'doc-1',
    filename: 'guia.pdf',
    storagePath: 'Acme/guia.pdf',
    scopePath: 'Acme',
    chunkIndex: 0,
    pageNumber: 1,
    embeddingModel: 'nomic-embed-text',
    distance: 1 - overrides.similarity,
    ...overrides,
  };
}

const ORCAMENTO = { minSimilarity: 0.25, maxChars: 100, maxSnippets: 5 };

describe('applyRetrievalBudget', () => {
  it('ordena por relevância e mantém a procedência de cada trecho', () => {
    const { snippets, evidence } = applyRetrievalBudget(
      [chunk({ content: 'menos perto', similarity: 0.4 }), chunk({ content: 'mais perto', similarity: 0.9 })],
      ORCAMENTO,
    );

    expect(snippets.map((item) => item.content)).toEqual(['mais perto', 'menos perto']);
    expect(snippets[0].filename).toBe('guia.pdf');
    expect(evidence.bestSimilarity).toBe(0.9);
    expect(evidence.sufficient).toBe(true);
  });

  it('descarta o que está abaixo do piso de similaridade', () => {
    const { snippets, evidence } = applyRetrievalBudget(
      [chunk({ content: 'pertinente', similarity: 0.8 }), chunk({ content: 'nada a ver', similarity: 0.1 })],
      ORCAMENTO,
    );

    expect(snippets.map((item) => item.content)).toEqual(['pertinente']);
    expect(evidence.discardedByRelevance).toBe(1);
    expect(evidence.used).toBe(1);
    expect(evidence.considered).toBe(2);
  });

  it('acervo com tudo abaixo do piso é evidência insuficiente, e não erro', () => {
    const { snippets, evidence } = applyRetrievalBudget(
      [chunk({ content: 'nada a ver', similarity: 0.05 })],
      ORCAMENTO,
    );

    expect(snippets).toEqual([]);
    expect(evidence.sufficient).toBe(false);
    expect(evidence.bestSimilarity).toBe(0.05);
  });

  it('busca sem resultado nenhum não tem melhor similaridade', () => {
    const { evidence } = applyRetrievalBudget([], ORCAMENTO);

    expect(evidence).toMatchObject({
      considered: 0,
      used: 0,
      bestSimilarity: null,
      sufficient: false,
    });
  });

  it('respeita o teto de caracteres, do mais relevante para o menos', () => {
    const { snippets, evidence } = applyRetrievalBudget(
      [
        chunk({ content: 'a'.repeat(60), similarity: 0.9 }),
        chunk({ content: 'b'.repeat(60), similarity: 0.8 }),
        chunk({ content: 'c'.repeat(30), similarity: 0.7 }),
      ],
      ORCAMENTO,
    );

    expect(snippets.map((item) => item.content[0])).toEqual(['a', 'c']);
    expect(evidence.discardedByBudget).toBe(1);
  });

  it('um único trecho acima do teto ainda entra, para não devolver vazio com acervo pertinente', () => {
    const { snippets, evidence } = applyRetrievalBudget(
      [chunk({ content: 'x'.repeat(500), similarity: 0.9 })],
      ORCAMENTO,
    );

    expect(snippets).toHaveLength(1);
    expect(evidence.sufficient).toBe(true);
  });

  it('respeita o teto de quantidade de trechos', () => {
    const muitos = Array.from({ length: 8 }, (_, index) =>
      chunk({ content: `t${index}`, similarity: 0.9 - index / 100 }));

    const { snippets } = applyRetrievalBudget(muitos, { ...ORCAMENTO, maxSnippets: 3 });

    expect(snippets).toHaveLength(3);
  });

  it('similaridade não numérica não passa pelo piso', () => {
    const { snippets, evidence } = applyRetrievalBudget(
      [chunk({ content: 'sem distância', similarity: Number.NaN })],
      ORCAMENTO,
    );

    expect(snippets).toEqual([]);
    expect(evidence.bestSimilarity).toBeNull();
    expect(evidence.sufficient).toBe(false);
  });
});
