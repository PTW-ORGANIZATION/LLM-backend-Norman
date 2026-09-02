import { describe, expect, it } from 'vitest';
import {
  DOCUMENT_SUMMARY_VERSION,
  InvalidNoteContentError,
  noteNeedsRegeneration,
  parseDocumentSummary,
} from './note-content';

const VALID = {
  titulo: 'Brand guide da AcmeCorp',
  tipo: 'brand guide',
  idioma: 'pt',
  resumo: 'Define o tom de voz e a paleta da marca.',
  topicos: ['tom de voz', 'paleta'],
  entidades: ['AcmeCorp'],
};

describe('parseDocumentSummary', () => {
  it('aceita a nota bem formada', () => {
    expect(parseDocumentSummary(VALID)).toEqual(VALID);
  });

  it.each([
    ['string', 'resumo solto'],
    ['array', [VALID]],
    ['nulo', null],
    ['número', 7],
  ])('recusa conteúdo que não é objeto JSON (%s)', (_label, raw) => {
    expect(() => parseDocumentSummary(raw)).toThrow(InvalidNoteContentError);
  });

  it.each([
    ['ausente', {}],
    ['vazio', { resumo: '   ' }],
    ['não textual', { resumo: { texto: 'oi' } }],
  ])('recusa nota sem resumo utilizável (%s)', (_label, raw) => {
    expect(() => parseDocumentSummary(raw)).toThrow(/resumo/);
  });

  it('normaliza espaço e ignora campo que o modelo inventou', () => {
    const parsed = parseDocumentSummary({
      ...VALID,
      titulo: '  Brand   guide \n da AcmeCorp ',
      confianca: 0.9,
    });
    expect(parsed.titulo).toBe('Brand guide da AcmeCorp');
    expect(parsed).not.toHaveProperty('confianca');
  });

  it('aceita string solta onde esperava lista', () => {
    expect(parseDocumentSummary({ ...VALID, topicos: 'tom de voz' }).topicos).toEqual([
      'tom de voz',
    ]);
  });

  it('descarta item vazio, item aninhado e repetição', () => {
    const parsed = parseDocumentSummary({
      ...VALID,
      topicos: ['tom de voz', '', '  ', { t: 'x' }, ['y'], 'Tom de Voz'],
    });
    expect(parsed.topicos).toEqual(['tom de voz']);
  });

  it('corta lista longa demais em vez de recusar a nota', () => {
    const topicos = Array.from({ length: 40 }, (_, index) => `topico ${index}`);
    expect(parseDocumentSummary({ ...VALID, topicos }).topicos).toHaveLength(12);
  });

  it('trata campo faltando como vazio, desde que o resumo exista', () => {
    expect(parseDocumentSummary({ resumo: 'só o resumo' })).toEqual({
      titulo: '',
      tipo: '',
      idioma: '',
      resumo: 'só o resumo',
      topicos: [],
      entidades: [],
    });
  });
});

describe('noteNeedsRegeneration', () => {
  const target = {
    model: 'llama3.1:8b-instruct-q4_0',
    generatorVersion: DOCUMENT_SUMMARY_VERSION,
    sourceFingerprint: 'a'.repeat(64),
  };

  it('nota inexistente precisa ser gerada', () => {
    expect(noteNeedsRegeneration(null, target)).toBe(true);
  });

  it('nota igual em modelo, versão e conteúdo não é refeita', () => {
    expect(noteNeedsRegeneration({ ...target }, target)).toBe(false);
  });

  it.each([
    ['modelo', { model: 'outro-modelo' }],
    ['versão do gerador', { generatorVersion: target.generatorVersion + 1 }],
    ['conteúdo de origem', { sourceFingerprint: 'b'.repeat(64) }],
  ])('%s diferente força a regeração', (_label, patch) => {
    expect(noteNeedsRegeneration({ ...target, ...patch }, target)).toBe(true);
  });
});
