import { describe, expect, it } from 'vitest';
import { looksLikeBrandGuide } from './brand-guide-detection';

describe('looksLikeBrandGuide', () => {
  it.each([
    ['a pasta que o Norman cria para o cliente', 'Vitalis/01_Brand_Guide_Institucional', 'a.pdf'],
    ['a pasta que o Norman cria para o produto', 'Vitalis/Linha_X/01_Brand_Guide_Produto', 'a.pdf'],
    ['o nome do arquivo em português', 'Vitalis/00_Assets', 'Manual de Marca 2026.pdf'],
    ['o nome do arquivo sem acento', 'Vitalis/00_Assets', 'manual da marca.pdf'],
    ['grafia colada', 'Vitalis/00_Assets', 'VitalisBrandGuide_v3.pdf'],
    ['identidade visual', 'Vitalis/00_Assets', 'Identidade Visual.pdf'],
    ['a pasta sanitizada com underline a mais', 'Jonson___Co/01_Brand_Guide_Institucional', 'x.pdf'],
  ])('reconhece por %s', (_label, scopePath, filename) => {
    expect(looksLikeBrandGuide({ scopePath, filename })).toBe(true);
  });

  it.each([
    ['plano de mídia', 'Vitalis/03_Campanhas', 'plano-de-midia.xlsx'],
    ['contrato', 'Vitalis/Juridico', 'contrato.pdf'],
    ['pasta de assets', 'Vitalis/00_Assets_Institucionais', 'logo.png'],
  ])('não confunde %s com brand guide', (_label, scopePath, filename) => {
    expect(looksLikeBrandGuide({ scopePath, filename })).toBe(false);
  });

  it('aceita caminho ou nome ausente sem quebrar', () => {
    expect(looksLikeBrandGuide({})).toBe(false);
    expect(looksLikeBrandGuide({ scopePath: null, filename: null })).toBe(false);
    expect(looksLikeBrandGuide({ filename: 'brand guide.pdf' })).toBe(true);
  });
});
