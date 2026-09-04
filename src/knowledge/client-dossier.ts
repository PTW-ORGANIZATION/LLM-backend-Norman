import { createHash } from 'crypto';
import {
  asText,
  asTextList,
  BrandColor,
  BrandGuideNote,
  DocumentSummary,
  InvalidNoteContentError,
  isPlainObject,
  parseBrandGuideNote,
} from './note-content';

export const CLIENT_DOSSIER_VERSION = 3;

export interface ClientSynthesis {
  resumo: string;
  setor: string;
  temasRecorrentes: string[];
}

// Só os campos que precisam de síntese. Tom de voz, cores e proibições NÃO
// entram aqui: eles já vêm apurados da ficha do brand guide e são copiados,
// não reescritos — pedir ao modelo que os repita seria abrir espaço para ele
// inventar uma cor que o manual não tem.
export const CLIENT_SYNTHESIS_SCHEMA = {
  type: 'object',
  properties: {
    resumo: { type: 'string' },
    setor: { type: 'string' },
    temasRecorrentes: { type: 'array', items: { type: 'string' } },
  },
  required: ['resumo', 'setor', 'temasRecorrentes'],
} as const;

export function parseClientSynthesis(raw: unknown): ClientSynthesis {
  if (!isPlainObject(raw)) {
    throw new InvalidNoteContentError('a síntese do cliente precisa ser um objeto JSON');
  }

  const resumo = asText(raw.resumo, 4000);
  if (!resumo) {
    throw new InvalidNoteContentError('a síntese do cliente veio sem "resumo"');
  }

  return {
    resumo,
    setor: asText(raw.setor, 200),
    temasRecorrentes: asTextList(raw.temasRecorrentes, 15),
  };
}

export interface DossierDocument {
  arquivo: string;
  pasta: string;
  tipo: string;
  resumo: string;
  topicos: string[];
  entidades: string[];
  identificadores: string[];
}

export interface ClientDossier {
  resumo: string;
  setor: string;
  temasRecorrentes: string[];
  tomDeVoz: string;
  publico: string;
  cores: BrandColor[];
  tipografia: string[];
  restricoes: string[];
  proibicoes: string[];
  documentos: DossierDocument[];
}

export interface DocumentNoteRow {
  documentId: string;
  kind: string;
  filename: string;
  scopePath: string | null;
  sourceFingerprint: string;
  content: Record<string, unknown>;
}

/**
 * A impressão digital do acervo de um cliente.
 *
 * É o que decide se o dossiê está velho: muda quando um documento entra, sai ou
 * é reingerido com conteúdo novo. Ordena antes de somar porque a ordem em que o
 * banco devolve as linhas não é contrato — sem isso o dossiê seria regerado a
 * cada consolidação por causa de um `ORDER BY` que empatou diferente.
 */
export function fingerprintClientNotes(notes: DocumentNoteRow[]): string {
  const lines = notes
    .map((note) => `${note.documentId}:${note.kind}:${note.sourceFingerprint}`)
    .sort();

  return createHash('sha256').update(lines.join('\n')).digest('hex');
}

function summaryOf(note: DocumentNoteRow): DocumentSummary | null {
  const content = note.content;
  const resumo = asText(content.resumo, 4000);
  return resumo
    ? {
        titulo: asText(content.titulo, 300),
        tipo: asText(content.tipo, 120),
        idioma: asText(content.idioma, 40),
        resumo,
        topicos: asTextList(content.topicos, 12),
        entidades: asTextList(content.entidades, 20),
        identificadores: asTextList(content.identificadores, 20),
      }
    : null;
}

/**
 * O inventário do acervo, um item por documento resumido.
 *
 * Ordena por nome de arquivo para que dois dossiês do mesmo acervo saiam iguais.
 */
export function dossierDocuments(
  notes: DocumentNoteRow[],
  summaryKind: string,
  limit: number,
): DossierDocument[] {
  return notes
    .filter((note) => note.kind === summaryKind)
    .map((note) => ({ note, summary: summaryOf(note) }))
    .filter((entry): entry is { note: DocumentNoteRow; summary: DocumentSummary } => !!entry.summary)
    .sort((a, b) => a.note.filename.localeCompare(b.note.filename))
    .slice(0, Math.max(0, limit))
    .map(({ note, summary }) => ({
      arquivo: note.filename,
      pasta: note.scopePath ?? '',
      tipo: summary.tipo,
      resumo: summary.resumo,
      topicos: summary.topicos,
      entidades: summary.entidades,
      identificadores: summary.identificadores,
    }));
}

function pathDepth(scopePath: string | null): number {
  return (scopePath ?? '').split('/').filter(Boolean).length;
}

/**
 * A ficha de brand guide que manda no dossiê do cliente.
 *
 * Um cliente pode ter mais de uma — a institucional e a de cada produto. Vence
 * a de pasta mais rasa, que é a institucional: ela é a regra do cliente, e a de
 * produto é a exceção de um recorte.
 */
export function brandGuideOf(notes: DocumentNoteRow[], brandKind: string): BrandGuideNote | null {
  const candidates = notes
    .filter((note) => note.kind === brandKind)
    .sort(
      (a, b) => pathDepth(a.scopePath) - pathDepth(b.scopePath) || a.filename.localeCompare(b.filename),
    );

  for (const candidate of candidates) {
    try {
      return parseBrandGuideNote(candidate.content);
    } catch {
      continue;
    }
  }

  return null;
}

/**
 * O texto que o modelo lê para sintetizar o cliente: os resumos já apurados,
 * não os documentos originais. O acervo inteiro nunca caberia numa janela de
 * contexto, e reler o que já foi lido custaria a mesma GPU duas vezes.
 */
export function buildClientCorpus(documents: DossierDocument[], maxChars: number): string {
  const lines: string[] = [];
  let used = 0;

  for (const document of documents) {
    const line = `- ${document.arquivo} (${document.tipo || 'tipo não identificado'}): ${document.resumo}`;
    if (used + line.length > maxChars) break;
    lines.push(line);
    used += line.length + 1;
  }

  return lines.join('\n');
}

/**
 * O dossiê final: o que o modelo sintetizou mais o que a ficha do brand guide
 * já trazia apurado, copiado sem passar de novo pelo modelo.
 */
export function assembleClientDossier(input: {
  synthesis: ClientSynthesis;
  brandGuide: BrandGuideNote | null;
  documentos: DossierDocument[];
}): ClientDossier {
  const brand = input.brandGuide;

  return {
    resumo: input.synthesis.resumo,
    setor: input.synthesis.setor,
    temasRecorrentes: input.synthesis.temasRecorrentes,
    tomDeVoz: brand?.tomDeVoz ?? '',
    publico: brand?.publico ?? '',
    cores: brand?.cores ?? [],
    tipografia: brand?.tipografia ?? [],
    restricoes: brand?.restricoes ?? [],
    proibicoes: brand?.proibicoes ?? [],
    documentos: input.documentos,
  };
}
