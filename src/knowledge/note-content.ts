export class InvalidNoteContentError extends Error {}

export interface DocumentSummary {
  titulo: string;
  tipo: string;
  idioma: string;
  resumo: string;
  topicos: string[];
  entidades: string[];
  identificadores: string[];
}

/**
 * Sobe de 1 quando o prompt ou o formato da nota mudarem.
 *
 * A linha guarda a versão com que foi gerada, então subir este número marca todo
 * o acervo como desatualizado sem apagar nada — a nota velha continua servindo
 * até ser regerada.
 */
export const DOCUMENT_SUMMARY_VERSION = 2;

// Schema entregue ao Ollama em `format`. O modelo responde JSON que casa com
// ele; o parser abaixo não confia nisso e valida de novo.
export const DOCUMENT_SUMMARY_SCHEMA = {
  type: 'object',
  properties: {
    titulo: { type: 'string' },
    tipo: { type: 'string' },
    idioma: { type: 'string' },
    resumo: { type: 'string' },
    topicos: { type: 'array', items: { type: 'string' } },
    entidades: { type: 'array', items: { type: 'string' } },
    identificadores: { type: 'array', items: { type: 'string' } },
  },
  required: ['titulo', 'tipo', 'idioma', 'resumo', 'topicos', 'entidades', 'identificadores'],
} as const;

const LIMITS = {
  titulo: 300,
  tipo: 120,
  idioma: 40,
  resumo: 4000,
  item: 200,
  topicos: 12,
  entidades: 20,
  identificadores: 20,
};

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function asText(value: unknown, maxLength: number): string {
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value).slice(0, maxLength);
  }
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

/**
 * Normaliza uma lista de rótulos vinda do modelo.
 *
 * Aceita string solta como lista de um item porque é o desvio mais comum do
 * modelo quando só encontra um valor, e recusar isso jogaria fora uma nota boa.
 */
export function asTextList(value: unknown, maxItems: number): string[] {
  const raw = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
  const seen = new Set<string>();
  const items: string[] = [];

  for (const entry of raw) {
    if (isPlainObject(entry) || Array.isArray(entry)) continue;
    const text = asText(entry, LIMITS.item);
    if (!text) continue;
    const key = text.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(text);
    if (items.length === maxItems) break;
  }

  return items;
}

/**
 * O resumo de um documento a partir do que o modelo devolveu.
 *
 * Lança quando não há resumo utilizável — nota sem resumo não serve para nada e
 * gravá-la esconderia a falha atrás de uma linha aparentemente pronta. O resto
 * é normalizado em vez de recusado: campo a mais é ignorado, campo faltando vira
 * vazio e lista longa demais é cortada.
 */
export function parseDocumentSummary(raw: unknown): DocumentSummary {
  if (!isPlainObject(raw)) {
    throw new InvalidNoteContentError('a nota precisa ser um objeto JSON');
  }

  const resumo = asText(raw.resumo, LIMITS.resumo);
  if (!resumo) {
    throw new InvalidNoteContentError('a nota veio sem "resumo"');
  }

  return {
    titulo: asText(raw.titulo, LIMITS.titulo),
    tipo: asText(raw.tipo, LIMITS.tipo),
    idioma: asText(raw.idioma, LIMITS.idioma),
    resumo,
    topicos: asTextList(raw.topicos, LIMITS.topicos),
    entidades: asTextList(raw.entidades, LIMITS.entidades),
    identificadores: asTextList(raw.identificadores, LIMITS.identificadores),
  };
}

export interface BrandColor {
  nome: string;
  hex: string;
  uso: string;
}

export interface BrandGuideNote {
  tomDeVoz: string;
  publico: string;
  fazer: string[];
  evitar: string[];
  cores: BrandColor[];
  tipografia: string[];
  restricoes: string[];
  proibicoes: string[];
}

export const BRAND_GUIDE_VERSION = 1;

export const BRAND_GUIDE_SCHEMA = {
  type: 'object',
  properties: {
    tomDeVoz: { type: 'string' },
    publico: { type: 'string' },
    fazer: { type: 'array', items: { type: 'string' } },
    evitar: { type: 'array', items: { type: 'string' } },
    cores: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          nome: { type: 'string' },
          hex: { type: 'string' },
          uso: { type: 'string' },
        },
        required: ['nome', 'hex', 'uso'],
      },
    },
    tipografia: { type: 'array', items: { type: 'string' } },
    restricoes: { type: 'array', items: { type: 'string' } },
    proibicoes: { type: 'array', items: { type: 'string' } },
  },
  required: [
    'tomDeVoz',
    'publico',
    'fazer',
    'evitar',
    'cores',
    'tipografia',
    'restricoes',
    'proibicoes',
  ],
} as const;

const BRAND_LIMITS = {
  tomDeVoz: 2000,
  publico: 500,
  lista: 15,
  cores: 20,
};

/**
 * Normaliza uma cor para `#RRGGBB` maiúsculo.
 *
 * Devolve string vazia quando não é um hexadecimal de cor — o modelo às vezes
 * escreve "verde escuro" no campo, e gravar isso como se fosse código faria a
 * tela pintar preto.
 */
export function normalizeHexColor(value: unknown): string {
  const raw = asText(value, 20).replace(/^#/, '');
  if (/^[0-9a-fA-F]{3}$/.test(raw)) {
    return `#${raw
      .split('')
      .map((digit) => digit + digit)
      .join('')
      .toUpperCase()}`;
  }
  return /^[0-9a-fA-F]{6}$/.test(raw) ? `#${raw.toUpperCase()}` : '';
}

function asColorList(value: unknown): BrandColor[] {
  const raw = Array.isArray(value) ? value : [];
  const colors: BrandColor[] = [];

  for (const entry of raw) {
    if (!isPlainObject(entry)) continue;
    const nome = asText(entry.nome, 120);
    const hex = normalizeHexColor(entry.hex);
    if (!nome && !hex) continue;
    colors.push({ nome, hex, uso: asText(entry.uso, 300) });
    if (colors.length === BRAND_LIMITS.cores) break;
  }

  return colors;
}

/**
 * A ficha dirigida de um brand guide, a partir do que o modelo devolveu.
 *
 * Lança quando a ficha não traz nem tom de voz, nem cor, nem proibição: um
 * brand guide sem nenhum dos três não foi lido, e gravar a ficha vazia faria a
 * comparação de regeração considerá-la pronta para sempre.
 */
export function parseBrandGuideNote(raw: unknown): BrandGuideNote {
  if (!isPlainObject(raw)) {
    throw new InvalidNoteContentError('a ficha do brand guide precisa ser um objeto JSON');
  }

  const note: BrandGuideNote = {
    tomDeVoz: asText(raw.tomDeVoz, BRAND_LIMITS.tomDeVoz),
    publico: asText(raw.publico, BRAND_LIMITS.publico),
    fazer: asTextList(raw.fazer, BRAND_LIMITS.lista),
    evitar: asTextList(raw.evitar, BRAND_LIMITS.lista),
    cores: asColorList(raw.cores),
    tipografia: asTextList(raw.tipografia, BRAND_LIMITS.lista),
    restricoes: asTextList(raw.restricoes, BRAND_LIMITS.lista),
    proibicoes: asTextList(raw.proibicoes, BRAND_LIMITS.lista),
  };

  if (!note.tomDeVoz && note.cores.length === 0 && note.proibicoes.length === 0) {
    throw new InvalidNoteContentError(
      'a ficha do brand guide veio sem tom de voz, sem cor e sem proibição',
    );
  }

  return note;
}

export interface NoteProvenance {
  model: string;
  generatorVersion: number;
  sourceFingerprint: string;
}

/**
 * Se a nota precisa ser refeita: quando não existe, quando o conteúdo que ela
 * descreve mudou, ou quando o modelo ou o prompt que a produziram mudaram.
 */
export function noteNeedsRegeneration(
  note: NoteProvenance | null | undefined,
  target: NoteProvenance,
): boolean {
  if (!note) return true;
  return (
    note.model !== target.model ||
    note.generatorVersion !== target.generatorVersion ||
    note.sourceFingerprint !== target.sourceFingerprint
  );
}
