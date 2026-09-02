import { describe, expect, it } from 'vitest';
import { buildStudyExcerpt } from './study-excerpt';

describe('buildStudyExcerpt', () => {
  it('devolve vazio sem chunks', () => {
    expect(buildStudyExcerpt([], 1000)).toBe('');
    expect(buildStudyExcerpt(['   ', ''], 1000)).toBe('');
  });

  it('devolve o documento inteiro quando ele cabe', () => {
    expect(buildStudyExcerpt(['primeiro', 'segundo'], 1000)).toBe('primeiro\n\nsegundo');
  });

  it('respeita o teto de caracteres', () => {
    const chunks = Array.from({ length: 50 }, (_, index) => `parte ${index} `.repeat(20));
    expect(buildStudyExcerpt(chunks, 900).length).toBeLessThanOrEqual(900);
  });

  it('amostra ao longo do documento em vez de cortar no começo', () => {
    const chunks = Array.from({ length: 40 }, (_, index) => `MARCA${index} ` + 'x'.repeat(200));
    const excerpt = buildStudyExcerpt(chunks, 2000);

    expect(excerpt).toContain('MARCA0 ');
    expect(excerpt).toContain('MARCA39 ');
    expect(excerpt).toContain('[...]');
  });

  it('marca o que foi pulado', () => {
    const chunks = Array.from({ length: 10 }, (_, index) => `${index}`.repeat(300));
    expect(buildStudyExcerpt(chunks, 1000)).toContain('[...]');
  });

  it('corta o primeiro chunk quando nem ele cabe', () => {
    expect(buildStudyExcerpt(['abcdefghij', 'klmno'], 4)).toBe('abcd');
  });

  it('teto zero ou negativo devolve vazio', () => {
    expect(buildStudyExcerpt(['algo'], 0)).toBe('');
    expect(buildStudyExcerpt(['algo'], -10)).toBe('');
  });
});
