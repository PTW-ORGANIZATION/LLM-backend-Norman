export type ExtractionSource = 'pdf-text-layer' | 'pdf-ocr' | 'docx' | 'xlsx' | 'plain';

export interface ExtractedPage {
  /** 1-based. Nulo em formato sem paginação — DOCX, XLSX e texto puro. */
  pageNumber: number | null;
  text: string;
}

export interface ExtractedDocument {
  pages: ExtractedPage[];
  source: ExtractionSource;
}

export type DocumentKind = 'pdf' | 'docx' | 'xlsx' | 'plain';

/** Tipo de arquivo que a camada de extração não sabe ler. Não é falha de conteúdo. */
export class UnsupportedDocumentTypeError extends Error {
  constructor(readonly detail: string) {
    super(`Tipo de arquivo não suportado para extração: ${detail}`);
    this.name = 'UnsupportedDocumentTypeError';
  }
}

/** Arquivo legível cujo conteúdo textual saiu vazio. Vira `failed`, nunca sucesso vazio. */
export class EmptyExtractionError extends Error {
  constructor(readonly detail: string) {
    super(`Nenhum texto extraído: ${detail}`);
    this.name = 'EmptyExtractionError';
  }
}

const EXTENSION_KINDS: Record<string, DocumentKind> = {
  pdf: 'pdf',
  docx: 'docx',
  xlsx: 'xlsx',
  xlsm: 'xlsx',
  txt: 'plain',
  text: 'plain',
  md: 'plain',
  markdown: 'plain',
  csv: 'plain',
  tsv: 'plain',
  json: 'plain',
  yaml: 'plain',
  yml: 'plain',
  xml: 'plain',
  html: 'plain',
  htm: 'plain',
  log: 'plain',
};

const MIME_KINDS: Record<string, DocumentKind> = {
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
};

/**
 * O tipo de extração de um arquivo, pela extensão do nome e, como desempate,
 * pelo MIME declarado.
 *
 * A extensão vem primeiro de propósito: o Drive e o Supabase devolvem
 * `application/octet-stream` para boa parte do acervo, e confiar no MIME faria
 * um `.docx` cair como não suportado.
 */
export function detectDocumentKind(filename: string, mimeType?: string | null): DocumentKind {
  const extension = String(filename || '')
    .split('.')
    .pop()
    ?.toLowerCase()
    .trim();

  if (extension && EXTENSION_KINDS[extension]) {
    return EXTENSION_KINDS[extension];
  }

  const normalizedMime = String(mimeType || '')
    .split(';')[0]
    .toLowerCase()
    .trim();

  if (MIME_KINDS[normalizedMime]) {
    return MIME_KINDS[normalizedMime];
  }

  if (normalizedMime.startsWith('text/')) {
    return 'plain';
  }

  throw new UnsupportedDocumentTypeError(`${filename} (${mimeType || 'sem mime'})`);
}

/**
 * Texto pronto para virar chunk: sem caractere de controle, sem espaço
 * redundante e com no máximo uma linha em branco entre blocos.
 *
 * Preserva a quebra de linha porque ela é o limite de corte preferido do
 * chunker; colapsar tudo em uma linha só destruiria essa informação.
 */
export function normalizeExtractedText(raw: string): string {
  return String(raw || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/[\u00a0\u2007\u202f\ufeff]/g, ' ')
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** As páginas com texto aproveitável, já normalizadas. Página vazia é descartada. */
export function keepNonEmptyPages(pages: ExtractedPage[]): ExtractedPage[] {
  return pages
    .map((page) => ({ pageNumber: page.pageNumber, text: normalizeExtractedText(page.text) }))
    .filter((page) => page.text.length > 0);
}
