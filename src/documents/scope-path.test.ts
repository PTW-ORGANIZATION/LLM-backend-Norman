import { describe, expect, it } from 'vitest';
import { scopePathAncestors } from './scope-path';

describe('scopePathAncestors', () => {
  it('devolve a cadeia do cliente até a própria pasta', () => {
    expect(scopePathAncestors('AcmeCorp/Campanhas/Verao2026')).toEqual([
      'AcmeCorp',
      'AcmeCorp/Campanhas',
      'AcmeCorp/Campanhas/Verao2026',
    ]);
  });

  it('nunca inclui pasta irmã', () => {
    const ancestors = scopePathAncestors('AcmeCorp/Campanhas/Verao2026');
    expect(ancestors).not.toContain('AcmeCorp/Campanhas/Inverno2026');
    expect(ancestors).not.toContain('AcmeCorp/Financeiro');
  });

  it('nunca inclui pasta descendente', () => {
    expect(scopePathAncestors('AcmeCorp')).toEqual(['AcmeCorp']);
  });

  it('preserva o nome cru, sem re-sanitizar', () => {
    expect(scopePathAncestors('Jonson___Co/Brand')).toEqual(['Jonson___Co', 'Jonson___Co/Brand']);
  });

  it('recusa travessia em vez de descartar o ".." silenciosamente', () => {
    expect(scopePathAncestors('AcmeCorp/../Rival')).toEqual([]);
    expect(scopePathAncestors('..')).toEqual([]);
    expect(scopePathAncestors('AcmeCorp/..')).toEqual([]);
  });

  it('devolve vazio para caminho ausente ou sem segmento útil', () => {
    expect(scopePathAncestors('')).toEqual([]);
    expect(scopePathAncestors(null)).toEqual([]);
    expect(scopePathAncestors(undefined)).toEqual([]);
    expect(scopePathAncestors('/')).toEqual([]);
    expect(scopePathAncestors('./.')).toEqual([]);
  });
});
