import { describe, expect, it } from 'vitest';
import { clientDossierJobId, ingestDocumentJobId, studyDocumentJobId } from './job-id';

const DOC = '0f8b2c1e-6a4d-4c8b-9f1e-2b7d3a5c6e90';
const SHA = 'a'.repeat(64);
const CLIENTE = 'cli-jonson';

const TODOS = [
  ['ingestão', ingestDocumentJobId(DOC, SHA)],
  ['estudo', studyDocumentJobId(DOC, SHA)],
  ['dossiê', clientDossierJobId(CLIENTE)],
] as const;

describe('jobId das filas de conhecimento', () => {
  // O defeito que passou para o ambiente de desenvolvimento: o BullMQ recusa
  // `:` no id e todos os três continham. Nenhum teste pegou porque a fila
  // estava mockada em todos eles.
  it.each(TODOS)('%s não contém ":", que o BullMQ recusa', (_nome, id) => {
    expect(id).not.toContain(':');
  });

  it('os três tipos não colidem entre si', () => {
    const ids = TODOS.map(([, id]) => id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('é determinístico: o mesmo par devolve o mesmo id', () => {
    expect(ingestDocumentJobId(DOC, SHA)).toBe(ingestDocumentJobId(DOC, SHA));
    expect(studyDocumentJobId(DOC, SHA)).toBe(studyDocumentJobId(DOC, SHA));
    expect(clientDossierJobId(CLIENTE)).toBe(clientDossierJobId(CLIENTE));
  });

  it('documento diferente, ou conteúdo diferente, dá id diferente', () => {
    expect(ingestDocumentJobId(DOC, SHA)).not.toBe(ingestDocumentJobId('outro-doc', SHA));
    expect(ingestDocumentJobId(DOC, SHA)).not.toBe(ingestDocumentJobId(DOC, 'b'.repeat(64)));
  });

  it('o dossiê é fixo por cliente, para a rajada virar um job só', () => {
    expect(clientDossierJobId(CLIENTE)).toBe(clientDossierJobId(CLIENTE));
    expect(clientDossierJobId(CLIENTE)).not.toBe(clientDossierJobId('cli-vitalis'));
  });

  it('recusa em vez de deixar passar um id inválido', () => {
    expect(() => ingestDocumentJobId('doc:com:dois-pontos', SHA)).toThrow(/não pode conter/);
    expect(() => clientDossierJobId('cli:1')).toThrow(/não pode conter/);
  });
});
