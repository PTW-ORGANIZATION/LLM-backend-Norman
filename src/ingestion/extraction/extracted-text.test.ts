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

  it('reconhece os formatos legados do Office', () => {
    expect(detectDocumentKind('manual.doc')).toBe('doc');
    expect(detectDocumentKind('verba.xls')).toBe('xls');
    expect(detectDocumentKind('deck.pptx')).toBe('pptx');
  });

  it('reconhece extensão em maiúsculas', () => {
    expect(detectDocumentKind('MANUAL.DOC')).toBe('doc');
    expect(detectDocumentKind('VERBA.XLS')).toBe('xls');
    expect(detectDocumentKind('DECK.PPTX')).toBe('pptx');
  });

  it('prefere a extensão ao mime genérico do Drive e do Supabase', () => {
    expect(detectDocumentKind('briefing.docx', 'application/octet-stream')).toBe('docx');
    expect(detectDocumentKind('manual.doc', 'application/octet-stream')).toBe('doc');
    expect(detectDocumentKind('verba.xls', 'application/octet-stream')).toBe('xls');
    expect(detectDocumentKind('deck.pptx', 'application/octet-stream')).toBe('pptx');
  });

  it('usa o mime quando o nome não tem extensão conhecida', () => {
    expect(detectDocumentKind('arquivo', 'application/pdf')).toBe('pdf');
    expect(detectDocumentKind('arquivo', 'text/plain; charset=utf-8')).toBe('plain');
    expect(detectDocumentKind('arquivo', 'application/msword')).toBe('doc');
    expect(detectDocumentKind('arquivo', 'application/vnd.ms-excel')).toBe('xls');
    expect(
      detectDocumentKind(
        'arquivo',
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      ),
    ).toBe('pptx');
  });

  it('recusa tipo que não sabe ler', () => {
    expect(() => detectDocumentKind('acervo.zip')).toThrow(UnsupportedDocumentTypeError);
    expect(() => detectDocumentKind('desenho.svg', 'image/svg+xml')).toThrow(
      UnsupportedDocumentTypeError,
    );
  });

  /**
   * Imagem passou a ser lida pelo modelo de visão. Só os formatos que o
   * provedor aceita entram: anunciar um que ele recusa é pedir um arquivo que
   * nunca vai ser estudado.
   */
  it.each(['foto.png', 'foto.jpg', 'foto.jpeg', 'foto.webp'])('lê %s como imagem', (nome) => {
    expect(detectDocumentKind(nome)).toBe('image');
  });

  it.each(['image/png', 'image/jpeg', 'image/webp'])('lê o mime %s como imagem', (mime) => {
    expect(detectDocumentKind('arquivo-sem-extensao', mime)).toBe('image');
  });

  it('formato de imagem fora da lista continua recusado', () => {
    expect(() => detectDocumentKind('antigo.bmp', 'image/bmp')).toThrow(
      UnsupportedDocumentTypeError,
    );
    expect(() => detectDocumentKind('scan.tiff', 'image/tiff')).toThrow(
      UnsupportedDocumentTypeError,
    );
  });

  it('recusa o .ppt binário, que está fora do escopo desta camada', () => {
    expect(() => detectDocumentKind('antigo.ppt')).toThrow(UnsupportedDocumentTypeError);
    expect(() => detectDocumentKind('antigo.ppt', 'application/vnd.ms-powerpoint')).toThrow(
      UnsupportedDocumentTypeError,
    );
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
