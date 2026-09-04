import { describe, expect, it } from 'vitest';
import {
  DOCUMENT_SUMMARY_VERSION,
  InvalidNoteContentError,
  normalizeHexColor,
  noteNeedsRegeneration,
  parseBrandGuideNote,
  parseDocumentSummary,
} from './note-content';

const VALID = {
  titulo: 'Brand guide da AcmeCorp',
  tipo: 'brand guide',
  idioma: 'pt',
  resumo: 'Define o tom de voz e a paleta da marca.',
  topicos: ['tom de voz', 'paleta'],
  entidades: ['AcmeCorp'],
  identificadores: [],
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
      identificadores: [],
    });
  });
});

describe('normalizeHexColor', () => {
  it.each([
    ['#0f6b3d', '#0F6B3D'],
    ['0F6B3D', '#0F6B3D'],
    ['#abc', '#AABBCC'],
  ])('normaliza %s para %s', (raw, expected) => {
    expect(normalizeHexColor(raw)).toBe(expected);
  });

  it.each([['verde escuro'], ['#12345'], ['rgb(1,2,3)'], [null], [42]])(
    'descarta %j, que não é código de cor',
    (raw) => {
      expect(normalizeHexColor(raw)).toBe('');
    },
  );
});

describe('parseBrandGuideNote', () => {
  const VALID_BRAND = {
    tomDeVoz: 'Direto e caloroso.',
    publico: 'Cliente final.',
    fazer: ['falar simples'],
    evitar: ['jargão'],
    cores: [{ nome: 'verde Vitalis', hex: '#0F6B3D', uso: 'principal' }],
    tipografia: ['Inter'],
    restricoes: ['margem mínima de 2x'],
    proibicoes: ['distorcer o logotipo'],
  };

  it('aceita a ficha bem formada', () => {
    expect(parseBrandGuideNote(VALID_BRAND)).toEqual(VALID_BRAND);
  });

  it('normaliza o hexadecimal e mantém a cor sem código', () => {
    const parsed = parseBrandGuideNote({
      ...VALID_BRAND,
      cores: [
        { nome: 'verde', hex: '0f6b3d', uso: 'principal' },
        { nome: 'areia', hex: 'cor de areia', uso: 'apoio' },
      ],
    });

    expect(parsed.cores).toEqual([
      { nome: 'verde', hex: '#0F6B3D', uso: 'principal' },
      { nome: 'areia', hex: '', uso: 'apoio' },
    ]);
  });

  it('descarta cor sem nome e sem código', () => {
    const parsed = parseBrandGuideNote({
      ...VALID_BRAND,
      cores: [{ uso: 'sei lá' }, 'verde', { nome: 'verde', hex: '#0F6B3D', uso: '' }],
    });

    expect(parsed.cores).toEqual([{ nome: 'verde', hex: '#0F6B3D', uso: '' }]);
  });

  it('recusa ficha sem tom de voz, sem cor e sem proibição', () => {
    expect(() =>
      parseBrandGuideNote({ ...VALID_BRAND, tomDeVoz: '', cores: [], proibicoes: [] }),
    ).toThrow(InvalidNoteContentError);
  });

  it.each([
    ['só o tom de voz', { tomDeVoz: 'Direto.' }],
    ['só uma cor', { cores: [{ nome: 'verde', hex: '#0F6B3D', uso: '' }] }],
    ['só uma proibição', { proibicoes: ['não distorcer'] }],
  ])('aceita a ficha com %s', (_label, patch) => {
    expect(() => parseBrandGuideNote(patch)).not.toThrow();
  });

  it('recusa o que não é objeto JSON', () => {
    expect(() => parseBrandGuideNote('tom de voz direto')).toThrow(InvalidNoteContentError);
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

describe('identificadores literais', () => {
  const base = {
    titulo: 'Guia',
    tipo: 'Brand Guide',
    idioma: 'pt',
    resumo: 'Um resumo com o mínimo de duas frases. A segunda frase.',
    topicos: ['marca'],
    entidades: ['Selenita'],
    identificadores: [],
  };

  it('separa identificador de entidade, sem adivinhar pela forma da string', () => {
    const nota = parseDocumentSummary({ ...base, identificadores: ['ORQUIDEA CROMADA 47'] });
    expect(nota.identificadores).toEqual(['ORQUIDEA CROMADA 47']);
    expect(nota.entidades).toEqual(['Selenita']);
  });

  // O campo nasceu na versão 2. Nota gerada antes não o tem, e precisa continuar
  // legível — a linha antiga serve até ser regerada.
  it('nota da versão 1, sem o campo, vira lista vazia em vez de quebrar', () => {
    expect(parseDocumentSummary(base).identificadores).toEqual([]);
  });

  it('aceita frase-chave em caixa normal, que a heurística antiga classificaria errado', () => {
    const nota = parseDocumentSummary({ ...base, identificadores: ['Movimento que transforma'] });
    expect(nota.identificadores).toEqual(['Movimento que transforma']);
  });
});
