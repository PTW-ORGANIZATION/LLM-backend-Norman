import { describe, expect, it } from 'vitest';
import { BRAND_TOKENS_HEADER, renderBrandTokensBlock, type BrandTokenSet } from './brand-tokens';

function conjunto(tokens: BrandTokenSet['tokens']): BrandTokenSet {
  return { clientId: 'cli-1', revision: 3, provenance: 'dossier', tokens };
}

describe('renderBrandTokensBlock', () => {
  it('a cor e a tipografia aprovadas aparecem no bloco', () => {
    const bloco = renderBrandTokensBlock(conjunto([
      { kind: 'color', value: '#0B3D91', label: 'azul-cobalto', usage: 'fundo institucional' },
      { kind: 'typography', value: 'Inter' },
    ]));

    expect(bloco).toContain('- Cores: #0B3D91 (azul-cobalto) — fundo institucional');
    expect(bloco).toContain('- Tipografia: Inter');
  });

  // O dossiê é resumo gerado por modelo; o token é decisão registrada. Deixar
  // os dois no prompt sem dizer qual vale é como uma cor antiga volta a ser
  // usada.
  it('o bloco declara a precedência sobre o resumo consolidado', () => {
    const bloco = renderBrandTokensBlock(conjunto([{ kind: 'color', value: '#0B3D91' }]));

    expect(bloco.split('\n')[0]).toBe(BRAND_TOKENS_HEADER);
    expect(bloco).toContain('valem estes');
  });

  it('a ordem das seções não depende da ordem de chegada', () => {
    const direta = renderBrandTokensBlock(conjunto([
      { kind: 'color', value: '#0B3D91' },
      { kind: 'prohibition', value: 'não usar gradiente' },
      { kind: 'tone', value: 'direto' },
    ]));
    const embaralhada = renderBrandTokensBlock(conjunto([
      { kind: 'tone', value: 'direto' },
      { kind: 'prohibition', value: 'não usar gradiente' },
      { kind: 'color', value: '#0B3D91' },
    ]));

    expect(direta).toBe(embaralhada);
  });

  it('conjunto vazio não produz bloco', () => {
    expect(renderBrandTokensBlock(conjunto([]))).toBe('');
    expect(renderBrandTokensBlock(undefined)).toBe('');
    expect(renderBrandTokensBlock(null)).toBe('');
  });

  it('token sem valor não vira linha em branco no prompt', () => {
    expect(renderBrandTokensBlock(conjunto([{ kind: 'color', value: '   ' }]))).toBe('');
  });

  it('rótulo igual ao valor não é repetido entre parênteses', () => {
    const bloco = renderBrandTokensBlock(conjunto([
      { kind: 'typography', value: 'Inter', label: 'Inter' },
    ]));

    expect(bloco).toContain('- Tipografia: Inter');
    expect(bloco).not.toContain('(Inter)');
  });
});
