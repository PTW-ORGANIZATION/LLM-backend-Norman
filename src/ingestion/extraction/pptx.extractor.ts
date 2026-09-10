import {
  DocumentTooLargeError,
  MalformedDocumentError,
  ProtectedDocumentError,
} from './extracted-text';

const RELATIONSHIP_NAMESPACE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const NOTES_RELATIONSHIP = `${RELATIONSHIP_NAMESPACE}/notesSlide`;
const IMAGE_RELATIONSHIP = `${RELATIONSHIP_NAMESPACE}/image`;

const BOILERPLATE_PLACEHOLDERS = new Set(['sldNum', 'ftr', 'dt']);
const TITLE_PLACEHOLDERS = new Set(['title', 'ctrTitle']);

const OLE_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0]);

interface ZipEntry {
  _data?: { uncompressedSize?: number };
  async(kind: 'nodebuffer'): Promise<Buffer>;
  async(kind: 'string'): Promise<string>;
}

interface ZipArchive {
  file(path: string): ZipEntry | null;
  files: Record<string, ZipEntry>;
}

interface SaxAttribute {
  value: string;
  uri?: string;
  local?: string;
}

interface SaxTag {
  local: string;
  uri: string;
  attributes: Record<string, SaxAttribute>;
}

interface SaxParser {
  on(event: 'opentag', handler: (tag: SaxTag) => void): void;
  on(event: 'closetag', handler: (tag: SaxTag) => void): void;
  on(event: 'text', handler: (text: string) => void): void;
  on(event: 'error', handler: (error: Error) => void): void;
  write(chunk: string): SaxParser;
  close(): void;
}

interface SaxHandlers {
  open?: (tag: SaxTag, stack: string[]) => void;
  close?: (tag: SaxTag, stack: string[]) => void;
  text?: (text: string, stack: string[]) => void;
}

export interface PptxSlide {
  slideNumber: number;
  text: string;
  /** Partes de imagem do slide, na ordem em que aparecem, para OCR sob demanda. */
  imageParts: string[];
}

/**
 * Caminho de uma parte do pacote a partir de um alvo relativo de relacionamento.
 *
 * Os alvos vêm relativos à pasta da parte que os declara — `slide1.xml.rels`
 * aponta as notas como `../notesSlides/notesSlide1.xml` —, então resolver isso
 * como caminho absoluto do zip é obrigatório antes de qualquer leitura.
 */
export function resolvePartPath(baseDirectory: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1);

  const segments = baseDirectory.split('/').filter((segment) => segment.length > 0);
  for (const segment of target.split('/')) {
    if (segment === '.' || segment === '') continue;
    if (segment === '..') segments.pop();
    else segments.push(segment);
  }
  return segments.join('/');
}

function parseXml(xml: string, handlers: SaxHandlers): void {
  const { SaxesParser } = require('saxes') as {
    SaxesParser: new (options: { xmlns: boolean }) => SaxParser;
  };

  const parser = new SaxesParser({ xmlns: true });
  const stack: string[] = [];
  let failure: Error | null = null;

  parser.on('error', (error) => {
    failure = failure ?? error;
  });
  parser.on('opentag', (tag) => {
    stack.push(tag.local);
    handlers.open?.(tag, stack);
  });
  parser.on('text', (text) => {
    handlers.text?.(text, stack);
  });
  parser.on('closetag', (tag) => {
    handlers.close?.(tag, stack);
    stack.pop();
  });

  parser.write(xml).close();

  if (failure) {
    throw new MalformedDocumentError(`XML do PPTX inválido: ${(failure as Error).message}`);
  }
}

function renderTable(rows: string[][]): string {
  return rows
    .map((row) => row.map((cell) => cell.trim()).join(' | '))
    .filter((line) => line.replace(/[ |]/g, '').length > 0)
    .join('\n');
}

interface ShapeTextResult {
  titleBlocks: string[];
  bodyBlocks: string[];
  imageRelationshipIds: string[];
  chartRelationshipIds: string[];
}

/**
 * O texto de um slide (ou de uma folha de notas), na ordem do `spTree`.
 *
 * A ordem do XML é a ordem de leitura que o PowerPoint usa no próprio painel de
 * estrutura, e é a aproximação mais fiel da ordem visual sem reimplementar o
 * layout. O título sai separado para poder abrir o bloco do slide.
 *
 * Placeholder de número de página, rodapé e data é descartado: repetir isso em
 * todo slide só polui o chunk sem acrescentar conhecimento.
 */
function collectShapeText(xml: string): ShapeTextResult {
  const titleBlocks: string[] = [];
  const bodyBlocks: string[] = [];
  const imageRelationshipIds: string[] = [];
  const chartRelationshipIds: string[] = [];

  let shape: { placeholder: string | null; blocks: string[] } | null = null;
  let paragraphRuns: string[] = [];
  let cellParagraphs: string[] | null = null;
  let currentRow: string[] | null = null;
  let tableRows: string[][] | null = null;
  let insideTextRun = false;

  const attribute = (tag: SaxTag, name: string): string | undefined => {
    for (const key of Object.keys(tag.attributes)) {
      const found = tag.attributes[key];
      if (found.local === name || key === name || key.endsWith(`:${name}`)) return found.value;
    }
    return undefined;
  };

  parseXml(xml, {
    open: (tag) => {
      switch (tag.local) {
        case 'sp':
        case 'pic':
        case 'graphicFrame':
          shape = { placeholder: null, blocks: [] };
          break;
        case 'ph':
          if (shape) shape.placeholder = attribute(tag, 'type') ?? 'body';
          break;
        case 'tbl':
          tableRows = [];
          break;
        case 'tr':
          currentRow = [];
          break;
        case 'tc':
          cellParagraphs = [];
          break;
        case 'p':
          paragraphRuns = [];
          break;
        case 'br':
          paragraphRuns.push('\n');
          break;
        case 'blip': {
          const relationshipId = attribute(tag, 'embed');
          if (relationshipId) imageRelationshipIds.push(relationshipId);
          break;
        }
        case 'chart': {
          const relationshipId = attribute(tag, 'id');
          if (relationshipId) chartRelationshipIds.push(relationshipId);
          break;
        }
        case 't':
          insideTextRun = true;
          break;
        default:
          break;
      }
    },

    text: (text) => {
      if (insideTextRun) paragraphRuns.push(text);
    },

    close: (tag) => {
      switch (tag.local) {
        case 't':
          insideTextRun = false;
          break;
        case 'p': {
          const line = paragraphRuns.join('').replace(/[ \t]+/g, ' ').trim();
          if (cellParagraphs) cellParagraphs.push(line);
          else if (shape && line.length > 0) shape.blocks.push(line);
          paragraphRuns = [];
          break;
        }
        case 'tc':
          currentRow?.push((cellParagraphs ?? []).filter((line) => line.length > 0).join(' '));
          cellParagraphs = null;
          break;
        case 'tr':
          if (currentRow) tableRows?.push(currentRow);
          currentRow = null;
          break;
        case 'tbl': {
          const table = renderTable(tableRows ?? []);
          if (table.length > 0 && shape) shape.blocks.push(table);
          tableRows = null;
          break;
        }
        case 'sp':
        case 'pic':
        case 'graphicFrame': {
          const finished = shape;
          shape = null;
          if (!finished || finished.blocks.length === 0) break;
          if (finished.placeholder && BOILERPLATE_PLACEHOLDERS.has(finished.placeholder)) break;
          if (finished.placeholder && TITLE_PLACEHOLDERS.has(finished.placeholder)) {
            titleBlocks.push(finished.blocks.join('\n'));
          } else {
            bodyBlocks.push(finished.blocks.join('\n'));
          }
          break;
        }
        default:
          break;
      }
    },
  });

  return { titleBlocks, bodyBlocks, imageRelationshipIds, chartRelationshipIds };
}

/**
 * Os rótulos textuais de um gráfico: título, nome de série e categorias.
 *
 * Só o que está em `strCache` entra. O `numCache` é a série numérica, e sem os
 * eixos ela chegaria ao chunk como uma lista de números soltos.
 */
function collectChartLabels(xml: string): string[] {
  const labels: string[] = [];
  let buffer: string[] = [];
  let capturing = false;

  parseXml(xml, {
    open: (tag, stack) => {
      if (tag.local === 'v' && stack.includes('strCache')) capturing = true;
      if (tag.local === 't') capturing = true;
      if (capturing) buffer = [];
    },
    text: (text) => {
      if (capturing) buffer.push(text);
    },
    close: (tag) => {
      if (tag.local !== 'v' && tag.local !== 't') return;
      if (!capturing) return;
      capturing = false;
      const label = buffer.join('').trim();
      if (label.length > 0 && !labels.includes(label)) labels.push(label);
      buffer = [];
    },
  });

  return labels;
}

/**
 * Um PPTX aberto uma vez, para ler os slides e, quando o texto de um slide vier
 * curto demais, buscar as imagens dele para o OCR sem reabrir o pacote.
 */
export class PptxReader {
  private constructor(private readonly archive: ZipArchive) {}

  static async open(content: Buffer, maxExpandedBytes = 314572800): Promise<PptxReader> {
    if (content.subarray(0, 4).equals(OLE_MAGIC)) {
      throw new ProtectedDocumentError('.pptx cifrado (pacote OLE em vez de zip)');
    }

    const JSZip = require('jszip') as { loadAsync(data: Buffer): Promise<ZipArchive> };
    try {
      const archive = await JSZip.loadAsync(content);
      const expandedBytes = Object.values(archive.files).reduce(
        (total, entry) => total + (entry._data?.uncompressedSize ?? 0),
        0,
      );
      if (expandedBytes > maxExpandedBytes) {
        throw new DocumentTooLargeError(
          `.pptx expande para ${expandedBytes} bytes, acima do teto de ${maxExpandedBytes}`,
        );
      }
      return new PptxReader(archive);
    } catch (error) {
      if (error instanceof DocumentTooLargeError) throw error;
      throw new MalformedDocumentError(
        `.pptx não é um pacote válido: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  private async readText(part: string): Promise<string | null> {
    const entry = this.archive.file(part);
    if (!entry) return null;
    return entry.async('string');
  }

  private async readRelationships(
    part: string,
  ): Promise<Map<string, { type: string; target: string }>> {
    const directory = part.split('/').slice(0, -1).join('/');
    const relationshipPart = `${directory}/_rels/${part.split('/').pop()}.rels`;
    const xml = await this.readText(relationshipPart);
    const relationships = new Map<string, { type: string; target: string }>();
    if (!xml) return relationships;

    parseXml(xml, {
      open: (tag) => {
        if (tag.local !== 'Relationship') return;
        const id = tag.attributes.Id?.value;
        const type = tag.attributes.Type?.value;
        const target = tag.attributes.Target?.value;
        if (id && type && target) {
          relationships.set(id, { type, target: resolvePartPath(directory, target) });
        }
      },
    });

    return relationships;
  }

  /**
   * Os caminhos das partes de slide na ordem da apresentação.
   *
   * A ordem vem do `sldIdLst` do `presentation.xml`, não do número no nome do
   * arquivo: um slide reordenado no PowerPoint mantém o nome antigo, e ordenar
   * por nome entregaria o deck fora de ordem.
   */
  private async slideParts(): Promise<string[]> {
    const presentation = await this.readText('ppt/presentation.xml');
    const relationships = await this.readRelationships('ppt/presentation.xml');

    if (presentation) {
      const ordered: string[] = [];
      parseXml(presentation, {
        open: (tag, stack) => {
          if (tag.local !== 'sldId' || !stack.includes('sldIdLst')) return;
          for (const key of Object.keys(tag.attributes)) {
            const attribute = tag.attributes[key];
            if (attribute.local !== 'id' && !key.endsWith(':id')) continue;
            const target = relationships.get(attribute.value);
            if (target) ordered.push(target.target);
          }
        },
      });
      if (ordered.length > 0) return ordered;
    }

    return Object.keys(this.archive.files)
      .filter((part) => /^ppt\/slides\/slide\d+\.xml$/.test(part))
      .sort((left, right) => {
        const number = (part: string) => Number(part.replace(/\D+/g, ''));
        return number(left) - number(right);
      });
  }

  /**
   * Um item por slide, na ordem da apresentação.
   *
   * Parte ilegível dentro de um zip válido sai como `MalformedDocumentError`,
   * não como falha genérica: defeito de arquivo não melhora na repetição, e a
   * fila repetiria o job para sempre.
   */
  async slides(maxSlides: number): Promise<PptxSlide[]> {
    try {
      return await this.readSlides(maxSlides);
    } catch (error) {
      if (error instanceof MalformedDocumentError || error instanceof ProtectedDocumentError) {
        throw error;
      }
      throw new MalformedDocumentError(
        `pacote PPTX inconsistente: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  private async readSlides(maxSlides: number): Promise<PptxSlide[]> {
    const parts = await this.slideParts();
    if (parts.length === 0) {
      throw new MalformedDocumentError('pacote PPTX sem nenhum slide');
    }

    const slides: PptxSlide[] = [];

    for (const [index, part] of parts.slice(0, maxSlides).entries()) {
      const xml = await this.readText(part);
      if (xml === null) continue;

      const content = collectShapeText(xml);
      const relationships = await this.readRelationships(part);
      const blocks = [...content.titleBlocks, ...content.bodyBlocks];

      for (const relationshipId of content.chartRelationshipIds) {
        const chartPart = relationships.get(relationshipId);
        if (!chartPart) continue;
        const chartXml = await this.readText(chartPart.target);
        if (!chartXml) continue;
        const labels = collectChartLabels(chartXml);
        if (labels.length > 0) blocks.push(labels.join(' | '));
      }

      const notes = await this.notesText(relationships);
      if (notes.length > 0) blocks.push(`Notas do apresentador: ${notes}`);

      const imageParts = content.imageRelationshipIds
        .map((relationshipId) => relationships.get(relationshipId))
        .filter((relationship) => relationship?.type === IMAGE_RELATIONSHIP)
        .map((relationship) => (relationship as { target: string }).target);

      slides.push({ slideNumber: index + 1, text: blocks.join('\n'), imageParts });
    }

    return slides;
  }

  private async notesText(
    relationships: Map<string, { type: string; target: string }>,
  ): Promise<string> {
    for (const relationship of relationships.values()) {
      if (relationship.type !== NOTES_RELATIONSHIP) continue;
      const xml = await this.readText(relationship.target);
      if (!xml) continue;
      const notes = collectShapeText(xml);
      return [...notes.titleBlocks, ...notes.bodyBlocks].join('\n').trim();
    }
    return '';
  }

  async readImagePart(part: string): Promise<Buffer | null> {
    const entry = this.archive.file(part);
    if (!entry) return null;
    return entry.async('nodebuffer');
  }
}
