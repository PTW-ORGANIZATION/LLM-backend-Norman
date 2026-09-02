export class InvalidNoteContentError extends Error {}

export interface DocumentSummary {
  titulo: string;
  tipo: string;
  idioma: string;
  resumo: string;
  topicos: string[];
  entidades: string[];
}

/**
 * Sobe de 1 quando o prompt ou o formato da nota mudarem.
 *
 * A linha guarda a versão com que foi gerada, então subir este número marca todo
 * o acervo como desatualizado sem apagar nada — a nota velha continua servindo
 * até ser regerada.
 */
export const DOCUMENT_SUMMARY_VERSION = 1;

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
  },
  required: ['titulo', 'tipo', 'idioma', 'resumo', 'topicos', 'entidades'],
} as const;

const LIMITS = {
  titulo: 300,
  tipo: 120,
  idioma: 40,
  resumo: 4000,
  item: 200,
  topicos: 12,
  entidades: 20,
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
  };
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
