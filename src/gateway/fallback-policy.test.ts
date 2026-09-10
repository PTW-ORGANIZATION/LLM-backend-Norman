import { describe, expect, it } from 'vitest';
import { decideFallback, FALLBACK_DISABLED } from './fallback-policy';
import type { ProviderFailureKind } from './llm-provider.port';

const PERMITIDO = {
  enabled: true,
  connectionKey: 'grok',
  connectionRevision: 5,
  model: 'grok-x',
  allowedCauses: ['unavailable', 'timeout'] as ProviderFailureKind[],
  maxAttempts: 2,
};

function decisao(overrides: Partial<Parameters<typeof decideFallback>[0]> = {}) {
  return decideFallback({
    policy: PERMITIDO,
    failure: 'unavailable',
    attemptsSoFar: 1,
    primaryKey: 'ollama',
    streamed: false,
    ...overrides,
  });
}

describe('decideFallback', () => {
  it('desligado por padrão', () => {
    expect(decideFallback({
      policy: FALLBACK_DISABLED,
      failure: 'unavailable',
      attemptsSoFar: 1,
      primaryKey: 'ollama',
      streamed: false,
    })).toEqual({ allowed: false, reason: 'fallback desligado' });
  });

  it('autoriza a causa configurada dentro do limite de tentativas', () => {
    expect(decisao()).toEqual({
      allowed: true,
      connectionKey: 'grok',
      connectionRevision: 5,
      model: 'grok-x',
    });
  });

  it.each([
    ['authorization'],
    ['invalid_request'],
    ['misconfigured'],
    ['cancelled'],
  ] as Array<[ProviderFailureKind]>)('não troca de provedor por %s, nem se o administrador listar', (failure) => {
    expect(decisao({
      failure,
      policy: { ...PERMITIDO, allowedCauses: [failure] },
    })).toEqual({
      allowed: false,
      reason: `a causa "${failure}" não autoriza troca de provedor`,
    });
  });

  it('causa elegível mas não autorizada pelo administrador não troca', () => {
    expect(decisao({ failure: 'rate_limited' })).toEqual({
      allowed: false,
      reason: 'a causa "rate_limited" não está entre as autorizadas',
    });
  });

  it('resposta já entregue não troca de provedor no meio', () => {
    expect(decisao({ streamed: true })).toEqual({
      allowed: false,
      reason: 'a resposta já começou a ser entregue',
    });
  });

  it('sem provedor alternativo configurado, não troca', () => {
    expect(decisao({ policy: { ...PERMITIDO, connectionKey: null } })).toEqual({
      allowed: false,
      reason: 'nenhum provedor alternativo configurado',
    });
  });

  it('alternativo igual ao principal não é fallback', () => {
    expect(decisao({ policy: { ...PERMITIDO, connectionKey: 'ollama' } })).toEqual({
      allowed: false,
      reason: 'o provedor alternativo é o mesmo do principal',
    });
  });

  it('limite de tentativas alcançado encerra em vez de insistir', () => {
    expect(decisao({ attemptsSoFar: 2 })).toEqual({
      allowed: false,
      reason: 'limite de tentativas alcançado',
    });
  });

  /**
   * Política ligada sem a revisão fixada é o formato antigo do contrato. Ela é
   * recusada aqui, e não completada com "a revisão mais nova": escolher por
   * aproximação é exatamente o defeito que a revisão fixada fecha.
   */
  it('política sem revisão fixada não autoriza fallback', () => {
    expect(decisao({ policy: { ...PERMITIDO, connectionRevision: null } })).toEqual({
      allowed: false,
      reason: 'a política de fallback não fixa a revisão aprovada do provedor alternativo',
    });
  });

  it('revisão fixada negativa não autoriza fallback', () => {
    expect(decisao({ policy: { ...PERMITIDO, connectionRevision: -1 } })).toEqual({
      allowed: false,
      reason: 'a política de fallback não fixa a revisão aprovada do provedor alternativo',
    });
  });

  it('política sem modelo fixado não autoriza fallback', () => {
    expect(decisao({ policy: { ...PERMITIDO, model: '   ' } })).toEqual({
      allowed: false,
      reason: 'a política de fallback não fixa o modelo aprovado do provedor alternativo',
    });
  });

  // A revisão 0 é legítima: uma conexão pode ter sido reconhecida na revisão 0,
  // e tratá-la como ausente por ser falsy recusaria um fallback aprovado.
  it('a revisão zero é uma revisão fixada válida', () => {
    expect(decisao({ policy: { ...PERMITIDO, connectionRevision: 0 } })).toEqual({
      allowed: true,
      connectionKey: 'grok',
      connectionRevision: 0,
      model: 'grok-x',
    });
  });
});
