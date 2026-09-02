import { describe, expect, it } from 'vitest';
import {
  UnsupportedDocumentTypeError,
  detectDocumentKind,
  keepNonEmptyPages,
  normalizeExtractedText,
} from './extracted-text';

describe('detectDocumentKind', () => {
  it('reconhece pela extensão', () => {
    expect(detectDocumentKind('contrato.pdf')).toBe('pdf');
    expect(detectDocumentKind('briefing.DOCX')).toBe('docx');
    expect(detectDocumentKind('midia.xlsx')).toBe('xlsx');
    expect(detectDocumentKind('notas.md')).toBe('plain');
  });

  it('prefere a extensão ao mime genérico do Drive e do Supabase', () => {
    expect(detectDocumentKind('briefing.docx', 'application/octet-stream')).toBe('docx');
  });

  it('usa o mime quando o nome não tem extensão conhecida', () => {
    expect(detectDocumentKind('arquivo', 'application/pdf')).toBe('pdf');
    expect(detectDocumentKind('arquivo', 'text/plain; charset=utf-8')).toBe('plain');
  });

  it('recusa tipo que não sabe ler', () => {
    expect(() => detectDocumentKind('acervo.zip')).toThrow(UnsupportedDocumentTypeError);
    expect(() => detectDocumentKind('logo.png', 'image/png')).toThrow(UnsupportedDocumentTypeError);
    expect(() => detectDocumentKind('legado.doc')).toThrow(UnsupportedDocumentTypeError);
  });
});

describe('normalizeExtractedText', () => {
  it('preserva a quebra de linha, que é o limite de corte do chunker', () => {
    expect(normalizeExtractedText('linha um\nlinha dois')).toBe('linha um\nlinha dois');
  });

  it('reduz a no máximo uma linha em branco entre blocos', () => {
    expect(normalizeExtractedText('a\n\n\n\n\nb')).toBe('a\n\nb');
  });

  it('remove caractere de controle e normaliza espaço não separável', () => {
    expect(normalizeExtractedText('a\u0000b\u0007c')).toBe('abc');
    expect(normalizeExtractedText('a\u00a0b')).toBe('a b');
    expect(normalizeExtractedText('\ufeffcabecalho')).toBe('cabecalho');
    expect(normalizeExtractedText('tab\tseparado')).toBe('tab separado');
  });

  it('colapsa espaço redundante sem juntar linhas', () => {
    expect(normalizeExtractedText('  a   b  \n   c  ')).toBe('a b\nc');
  });

  it('devolve vazio para entrada ausente', () => {
    expect(normalizeExtractedText('')).toBe('');
    expect(normalizeExtractedText('   \n  \n ')).toBe('');
  });
});

describe('keepNonEmptyPages', () => {
  it('descarta página que ficou vazia depois de normalizar', () => {
    expect(
      keepNonEmptyPages([
        { pageNumber: 1, text: '  \n ' },
        { pageNumber: 2, text: ' conteudo ' },
      ]),
    ).toEqual([{ pageNumber: 2, text: 'conteudo' }]);
  });
});
