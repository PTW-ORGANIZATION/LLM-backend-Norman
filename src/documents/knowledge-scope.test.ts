import { describe, expect, it } from 'vitest';
import {
  CLIENT_SCOPE,
  INGESTION_SCOPES,
  isIngestionScope,
  KNOWLEDGE_SCOPES,
  scopeOwnershipProblem,
  SYSTEM_SCOPE,
} from './knowledge-scope';

describe('níveis de acervo', () => {
  it('os três níveis existem e são distintos', () => {
    expect(KNOWLEDGE_SCOPES).toEqual(['system', 'client', 'person']);
    expect(new Set(KNOWLEDGE_SCOPES).size).toBe(KNOWLEDGE_SCOPES.length);
  });

  // O escopo de pessoa nasce do chat deste backend, não da ingestão vinda do
  // Norman: aceitá-lo no contrato interno abriria uma terceira porta de escrita
  // para linhas que ninguém do outro lado administra.
  it('a ingestão só aceita sistema e cliente', () => {
    expect(INGESTION_SCOPES).toEqual(['system', 'client']);
    expect(isIngestionScope('person')).toBe(false);
    expect(isIngestionScope('system')).toBe(true);
    expect(isIngestionScope('client')).toBe(true);
    expect(isIngestionScope('')).toBe(false);
    expect(isIngestionScope(undefined)).toBe(false);
    expect(isIngestionScope('SYSTEM')).toBe(false);
  });
});

describe('scopeOwnershipProblem', () => {
  it('acervo de cliente exige cliente', () => {
    expect(scopeOwnershipProblem({ scope: CLIENT_SCOPE, clientId: 'acme' })).toBeNull();
    expect(scopeOwnershipProblem({ scope: CLIENT_SCOPE, clientId: null })).toMatch(/exige clientId/);
    expect(scopeOwnershipProblem({ scope: CLIENT_SCOPE, clientId: '   ' })).toMatch(/exige clientId/);
  });

  // O `clientId` sintético é o defeito que esta regra fecha: uma fonte
  // compartilhada com um cliente inventado pertenceria a um dono e a todos ao
  // mesmo tempo, e nenhuma consulta conseguiria decidir qual das duas coisas
  // ela é.
  it('acervo geral recusa qualquer cliente, inclusive um inventado', () => {
    expect(scopeOwnershipProblem({ scope: SYSTEM_SCOPE, clientId: null })).toBeNull();
    expect(scopeOwnershipProblem({ scope: SYSTEM_SCOPE, clientId: undefined })).toBeNull();
    expect(scopeOwnershipProblem({ scope: SYSTEM_SCOPE, clientId: '' })).toBeNull();
    expect(scopeOwnershipProblem({ scope: SYSTEM_SCOPE, clientId: '__system__' })).toMatch(
      /não pertence a nenhum cliente/,
    );
    expect(scopeOwnershipProblem({ scope: SYSTEM_SCOPE, clientId: 'acme' })).toMatch(
      /não pertence a nenhum cliente/,
    );
  });

  it('nível fora da lista é recusado em vez de virar cliente', () => {
    expect(scopeOwnershipProblem({ scope: 'person' as never, clientId: 'acme' })).toMatch(
      /não é aceito/,
    );
    expect(scopeOwnershipProblem({ scope: 'geral' as never, clientId: null })).toMatch(
      /não é aceito/,
    );
  });
});
