import { describe, expect, it } from 'vitest';

import { mergeKnowledgeLayers } from '../src/knowledge/layered-retrieval';
import type { RetrievedChunk } from '../src/documents/document-chunks.service';
import { mesclarCamadas } from '@norman/modules/knowledge/mesclar-camadas';

/**
 * A mesclagem das duas camadas do acervo, comparada entre os dois serviços.
 *
 * A regra existe duas vezes: no executor, que a aplicava enquanto a geração
 * morava lá, e no Norman, que passou a orquestrar. A rota de busca devolve uma
 * camada por vez de propósito — mesclar nos dois lados daria dois lugares para
 * a precedência do cliente divergir, e a divergência não apareceria em lugar
 * nenhum: as duas respostas continuariam plausíveis, com trechos diferentes.
 *
 * A comparação é de comportamento, e não de texto. Os dois recebem a mesma
 * entrada e precisam escolher os mesmos trechos, na mesma ordem, com os mesmos
 * números de evidência. É o único teste que vê as duas implementações juntas.
 */

const ORCAMENTO = { minSimilarity: 0.25, maxChars: 8000, maxSnippets: 5 };

function trecho(conteudo: string, overrides: Partial<RetrievedChunk> = {}): RetrievedChunk {
  return {
    content: conteudo,
    knowledgeScope: 'client',
    documentId: `doc-${conteudo}`,
    storagePath: `caminho/${conteudo}`,
    scopePath: 'Cliente',
    chunkIndex: 0,
    pageNumber: null,
    filename: `${conteudo}.pdf`,
    similarity: 0.8,
    ...overrides,
  } as RetrievedChunk;
}

function geral(conteudo: string): RetrievedChunk {
  return trecho(conteudo, { knowledgeScope: 'system' });
}

function evidencia(quantos: number, overrides: Record<string, unknown> = {}) {
  return {
    considered: quantos,
    used: quantos,
    discardedByRelevance: 0,
    discardedByBudget: 0,
    bestSimilarity: 0.9,
    sufficient: quantos > 0,
    budget: ORCAMENTO,
    ...overrides,
  } as never;
}

function camada(snippets: RetrievedChunk[], overrides: Record<string, unknown> = {}) {
  return { snippets, evidence: evidencia(snippets.length, overrides) };
}

const CENARIOS: Array<{
  nome: string;
  cliente: ReturnType<typeof camada> | null;
  sistema: ReturnType<typeof camada> | null;
  sistemaDisponivel: boolean;
}> = [
  {
    nome: 'uma de cada camada',
    cliente: camada([trecho('a')]),
    sistema: camada([geral('g')]),
    sistemaDisponivel: true,
  },
  {
    nome: 'cliente povoado, com a reserva do acervo geral em disputa',
    cliente: camada(['a', 'b', 'c', 'd', 'e', 'f'].map((c) => trecho(c))),
    sistema: camada([geral('g1'), geral('g2'), geral('g3')]),
    sistemaDisponivel: true,
  },
  {
    nome: 'a reserva sobra e volta para o cliente',
    cliente: camada(['a', 'b', 'c', 'd', 'e', 'f'].map((c) => trecho(c))),
    sistema: camada([]),
    sistemaDisponivel: true,
  },
  {
    nome: 'acervo geral retido',
    cliente: camada([trecho('a')]),
    sistema: camada([geral('g')]),
    sistemaDisponivel: false,
  },
  {
    nome: 'o mesmo arquivo e trecho nas duas camadas',
    cliente: camada([trecho('x', { storagePath: 'guia.pdf', chunkIndex: 3 })]),
    sistema: camada([geral('y')].map((c) => ({ ...c, storagePath: 'guia.pdf', chunkIndex: 3 }))),
    sistemaDisponivel: true,
  },
  {
    nome: 'um trecho estoura o teto de caracteres sozinho',
    cliente: camada([trecho('x'.repeat(9000)), trecho('depois')]),
    sistema: null,
    sistemaDisponivel: true,
  },
  {
    nome: 'nenhuma camada trouxe nada',
    cliente: null,
    sistema: null,
    sistemaDisponivel: true,
  },
  {
    nome: 'camadas com evidência desigual',
    cliente: camada([trecho('a')], { considered: 10, discardedByRelevance: 4, bestSimilarity: 0.7 }),
    sistema: camada([geral('g')], { considered: 6, discardedByRelevance: 2, bestSimilarity: 0.95 }),
    sistemaDisponivel: true,
  },
];

describe('a mesclagem das camadas nos dois serviços', () => {
  it.each(CENARIOS)('escolhe os mesmos trechos: $nome', (cenario) => {
    const doExecutor = mergeKnowledgeLayers({
      client: cenario.cliente as never,
      system: cenario.sistema as never,
      budget: ORCAMENTO,
      systemAvailable: cenario.sistemaDisponivel,
    });

    const doNorman = mesclarCamadas({
      cliente: cenario.cliente
        ? { snippets: cenario.cliente.snippets.map(paraNorman), evidence: cenario.cliente.evidence }
        : null,
      sistema: cenario.sistema
        ? { snippets: cenario.sistema.snippets.map(paraNorman), evidence: cenario.sistema.evidence }
        : null,
      orcamento: ORCAMENTO,
      sistemaDisponivel: cenario.sistemaDisponivel,
    });

    expect(doNorman.snippets.map((s) => s.content)).toEqual(doExecutor.snippets.map((s) => s.content));
    expect(doNorman.snippets.map((s) => s.scope)).toEqual(
      doExecutor.snippets.map((s) => s.knowledgeScope),
    );
  });

  it.each(CENARIOS)('conta a mesma evidência: $nome', (cenario) => {
    const doExecutor = mergeKnowledgeLayers({
      client: cenario.cliente as never,
      system: cenario.sistema as never,
      budget: ORCAMENTO,
      systemAvailable: cenario.sistemaDisponivel,
    });

    const doNorman = mesclarCamadas({
      cliente: cenario.cliente
        ? { snippets: cenario.cliente.snippets.map(paraNorman), evidence: cenario.cliente.evidence }
        : null,
      sistema: cenario.sistema
        ? { snippets: cenario.sistema.snippets.map(paraNorman), evidence: cenario.sistema.evidence }
        : null,
      orcamento: ORCAMENTO,
      sistemaDisponivel: cenario.sistemaDisponivel,
    });

    for (const campo of ['considered', 'used', 'discardedByRelevance', 'discardedByBudget', 'bestSimilarity', 'sufficient'] as const) {
      expect({ [campo]: doNorman.evidence[campo] }).toEqual({ [campo]: doExecutor.evidence[campo] });
    }
    expect(doNorman.evidence.systemAvailable).toBe(doExecutor.evidence.systemAvailable);
  });
});

/** O mesmo trecho, na forma que o Norman recebe da rota de busca. */
function paraNorman(chunk: RetrievedChunk) {
  return {
    content: chunk.content,
    scope: chunk.knowledgeScope,
    documentId: chunk.documentId,
    filename: chunk.filename,
    storagePath: chunk.storagePath,
    scopePath: chunk.scopePath,
    chunkIndex: chunk.chunkIndex,
    pageNumber: chunk.pageNumber,
  } as never;
}
