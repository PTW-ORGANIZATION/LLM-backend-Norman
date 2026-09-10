export type ExtractionSource =
  | 'pdf-text-layer'
  | 'pdf-ocr'
  | 'docx'
  | 'doc'
  | 'xlsx'
  | 'xls'
  | 'pptx'
  | 'pptx-ocr'
  | 'plain';

export interface ExtractedPage {
  /** 1-based. Nulo em formato sem paginação — DOCX, DOC e texto puro. */
  pageNumber: number | null;
  text: string;
}

export interface ExtractedDocument {
  pages: ExtractedPage[];
  source: ExtractionSource;
}

export type DocumentKind = 'pdf' | 'docx' | 'doc' | 'xlsx' | 'xls' | 'pptx' | 'plain';

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

/**
 * Arquivo do tipo certo cuja estrutura não abre: truncado, corrompido ou de uma
 * variante que o extrator não lê.
 *
 * Separado de `EmptyExtractionError` porque a causa que aparece na tela é outra:
 * aqui o arquivo está quebrado, não sem texto.
 */
export class MalformedDocumentError extends Error {
  constructor(readonly detail: string) {
    super(`Arquivo ilegível ou corrompido: ${detail}`);
    this.name = 'MalformedDocumentError';
  }
}

/** Arquivo cifrado ou com senha de abertura. Só entra no acervo se for reenviado aberto. */
export class ProtectedDocumentError extends Error {
  constructor(readonly detail: string) {
    super(`Arquivo protegido por senha: ${detail}`);
    this.name = 'ProtectedDocumentError';
  }
}

/** Arquivo acima do teto de ingestão. Não é corrupção: é recusa por tamanho. */
export class DocumentTooLargeError extends Error {
  constructor(readonly detail: string) {
    super(`Arquivo acima do limite de ingestão: ${detail}`);
    this.name = 'DocumentTooLargeError';
  }
}

const EXTENSION_KINDS: Record<string, DocumentKind> = {
  pdf: 'pdf',
  docx: 'docx',
  doc: 'doc',
  xlsx: 'xlsx',
  xlsm: 'xlsx',
  xls: 'xls',
  pptx: 'pptx',
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
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  // A planilha com macro é lida pelo mesmo extrator do `xlsx`: o container é o
  // mesmo, e o que muda é só a presença do projeto VBA, que não é texto.
  'application/vnd.ms-excel.sheet.macroEnabled.12': 'xlsx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
};

/**
 * Os tipos que a extração sabe ler, por extensão e por MIME.
 *
 * Exportados porque a decisão de formato tem de ser uma só: cada rota que
 * mantinha a própria lista anunciava um conjunto diferente do que o extrator
 * realmente lê, e o Excel ficava de fora numa entrada e dentro em outra.
 */
export const SUPPORTED_DOCUMENT_EXTENSIONS = Object.keys(EXTENSION_KINDS);
export const SUPPORTED_DOCUMENT_MIME_TYPES = Object.keys(MIME_KINDS);

/** Se um arquivo é legível pela extração, sem tentar abri-lo. */
export function isSupportedDocument(filename: string, mimeType?: string | null): boolean {
  try {
    detectDocumentKind(filename, mimeType);
    return true;
  } catch {
    return false;
  }
}

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
