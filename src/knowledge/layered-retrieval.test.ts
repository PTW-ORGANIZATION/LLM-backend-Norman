import { describe, expect, it } from 'vitest';
import type { RetrievedChunk } from '../documents/document-chunks.service';
import { mergeKnowledgeLayers } from './layered-retrieval';
import { applyRetrievalBudget } from './retrieval-budget';

const BUDGET = { minSimilarity: 0.25, maxChars: 10000, maxSnippets: 5 };

function chunk(
  overrides: Partial<RetrievedChunk> & {
    content: string;
    similarity: number;
    knowledgeScope: 'system' | 'client';
  },
): RetrievedChunk {
  const slug = overrides.content.replace(/\W+/g, '-').slice(0, 40);
  return {
    documentId: `doc-${slug}`,
    filename: 'fonte.pdf',
    storagePath: `pasta/${slug}.pdf`,
    scopePath: 'pasta',
    chunkIndex: 0,
    pageNumber: null,
    embeddingModel: 'nomic-embed-text',
    distance: 1 - overrides.similarity,
    ...overrides,
  };
}

function layer(chunks: RetrievedChunk[], budget = BUDGET) {
  return applyRetrievalBudget(chunks, budget);
}

describe('mergeKnowledgeLayers', () => {
  it('junta as duas camadas com o cliente na frente', () => {
    const merged = mergeKnowledgeLayers({
      client: layer([chunk({ knowledgeScope: 'client', content: 'regra do cliente', similarity: 0.5 })]),
      system: layer([chunk({ knowledgeScope: 'system', content: 'regra geral', similarity: 0.9 })]),
      budget: BUDGET,
      systemAvailable: true,
    });

    expect(merged.snippets.map((snippet) => snippet.knowledgeScope)).toEqual(['client', 'system']);
    expect(merged.evidence.used).toBe(2);
    expect(merged.evidence.sufficient).toBe(true);
  });

  // A precedência é a regra de conflito, e ela é decidida pela ordem e pelo
  // orçamento: quando só um trecho cabe, é o do cliente que entra — mesmo que
  // a regra geral tenha similaridade maior.
  it('conflito entre regra geral e regra do cliente resolve pelo cliente', () => {
    const merged = mergeKnowledgeLayers({
      client: layer([
        chunk({ knowledgeScope: 'client', content: 'a cor da marca é azul-cobalto', similarity: 0.4 }),
      ]),
      system: layer([
        chunk({ knowledgeScope: 'system', content: 'a cor padrão do Norman é verde', similarity: 0.99 }),
      ]),
      budget: { ...BUDGET, maxSnippets: 1 },
      systemAvailable: true,
    });

    expect(merged.snippets).toHaveLength(1);
    expect(merged.snippets[0].knowledgeScope).toBe('client');
    expect(merged.snippets[0].content).toContain('azul-cobalto');
  });

  it('camada geral indisponível sai da mesclagem sem levar a do cliente', () => {
    const merged = mergeKnowledgeLayers({
      client: layer([chunk({ knowledgeScope: 'client', content: 'regra do cliente', similarity: 0.5 })]),
      system: layer([chunk({ knowledgeScope: 'system', content: 'regra geral', similarity: 0.9 })]),
      budget: BUDGET,
      systemAvailable: false,
    });

    expect(merged.snippets.map((snippet) => snippet.knowledgeScope)).toEqual(['client']);
    expect(merged.evidence.systemAvailable).toBe(false);
    expect(merged.evidence.layers.system).toBeNull();
    expect(merged.evidence.layers.client).toMatchObject({ used: 1 });
  });

  // Camada vazia e camada indisponível não podem parecer a mesma coisa: a
  // primeira é acervo sem nada a citar, a segunda é consulta que não pôde ser
  // feita, e tratá-las igual é como indisponibilidade vira "não existe regra".
  it('camada geral vazia é diferente de camada geral indisponível', () => {
    const vazia = mergeKnowledgeLayers({
      client: layer([]),
      system: layer([]),
      budget: BUDGET,
      systemAvailable: true,
    });
    const retida = mergeKnowledgeLayers({
      client: layer([]),
      system: null,
      budget: BUDGET,
      systemAvailable: false,
    });

    expect(vazia.evidence.systemAvailable).toBe(true);
    expect(vazia.evidence.layers.system).toMatchObject({ considered: 0, sufficient: false });
    expect(retida.evidence.systemAvailable).toBe(false);
    expect(retida.evidence.layers.system).toBeNull();
  });

  it('o mesmo arquivo nas duas camadas é citado uma vez só, pelo cliente', () => {
    const compartilhado = {
      documentId: 'doc-1',
      storagePath: 'pasta/manual.pdf',
      chunkIndex: 3,
      filename: 'manual.pdf',
    };
    const merged = mergeKnowledgeLayers({
      client: layer([
        chunk({ ...compartilhado, knowledgeScope: 'client', content: 'texto', similarity: 0.5 }),
      ]),
      system: layer([
        chunk({ ...compartilhado, knowledgeScope: 'system', content: 'texto', similarity: 0.8 }),
      ]),
      budget: BUDGET,
      systemAvailable: true,
    });

    expect(merged.snippets).toHaveLength(1);
    expect(merged.snippets[0].knowledgeScope).toBe('client');
  });

  it('soma os números das duas camadas e guarda cada uma separada', () => {
    const merged = mergeKnowledgeLayers({
      client: layer([
        chunk({ knowledgeScope: 'client', content: 'cliente forte', similarity: 0.7 }),
        chunk({ knowledgeScope: 'client', content: 'cliente fraco', similarity: 0.1 }),
      ]),
      system: layer([chunk({ knowledgeScope: 'system', content: 'sistema forte', similarity: 0.95 })]),
      budget: BUDGET,
      systemAvailable: true,
    });

    expect(merged.evidence).toMatchObject({
      considered: 3,
      used: 2,
      discardedByRelevance: 1,
      bestSimilarity: 0.95,
      sufficient: true,
    });
    expect(merged.evidence.layers.client).toMatchObject({ considered: 2, used: 1 });
    expect(merged.evidence.layers.system).toMatchObject({ considered: 1, used: 1 });
  });

  it('as duas camadas sem nada pertinente devolvem evidência insuficiente', () => {
    const merged = mergeKnowledgeLayers({
      client: layer([]),
      system: layer([]),
      budget: BUDGET,
      systemAvailable: true,
    });

    expect(merged.snippets).toEqual([]);
    expect(merged.evidence).toMatchObject({
      considered: 0,
      used: 0,
      bestSimilarity: null,
      sufficient: false,
    });
  });

  it('teto de caracteres conta as duas camadas juntas', () => {
    const merged = mergeKnowledgeLayers({
      client: layer([chunk({ knowledgeScope: 'client', content: 'x'.repeat(80), similarity: 0.5 })]),
      system: layer([chunk({ knowledgeScope: 'system', content: 'y'.repeat(80), similarity: 0.9 })]),
      budget: { ...BUDGET, maxChars: 100 },
      systemAvailable: true,
    });

    expect(merged.snippets).toHaveLength(1);
    expect(merged.snippets[0].knowledgeScope).toBe('client');
    expect(merged.evidence.discardedByBudget).toBe(1);
  });
});
