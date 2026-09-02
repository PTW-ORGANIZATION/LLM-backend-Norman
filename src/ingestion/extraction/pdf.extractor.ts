import * as path from 'path';
import { ExtractedPage } from './extracted-text';

interface PdfTextItem {
  str?: string;
  hasEOL?: boolean;
}

interface PdfViewport {
  width: number;
  height: number;
}

interface PdfPage {
  getTextContent(): Promise<{ items: PdfTextItem[] }>;
  getViewport(params: { scale: number }): PdfViewport;
  render(params: { canvasContext: unknown; viewport: PdfViewport }): { promise: Promise<void> };
  cleanup(): void;
}

interface PdfDocument {
  numPages: number;
  getPage(pageNumber: number): Promise<PdfPage>;
  destroy(): Promise<void>;
}

interface PdfjsModule {
  getDocument(params: Record<string, unknown>): { promise: Promise<PdfDocument> };
}

interface CanvasModule {
  createCanvas(width: number, height: number): {
    getContext(kind: '2d'): unknown;
    toBuffer(mime: 'image/png'): Buffer;
  };
  DOMMatrix: unknown;
  Path2D: unknown;
  ImageData: unknown;
}

let cachedPdfjs: PdfjsModule | null = null;
let cachedCanvas: CanvasModule | null = null;

/**
 * Carrega o pdfjs com `DOMMatrix`, `Path2D` e `ImageData` já no escopo global.
 *
 * Sem esses globais o pdfjs em Node tenta o pacote nativo `canvas`, não acha, e
 * **renderiza a página em branco sem lançar erro** — o OCR receberia uma folha
 * vazia e o documento entraria no acervo mudo. Por isso os globais são
 * instalados antes do `require`, e não depois.
 */
function loadPdfjs(): { pdfjs: PdfjsModule; canvas: CanvasModule } {
  if (cachedPdfjs && cachedCanvas) {
    return { pdfjs: cachedPdfjs, canvas: cachedCanvas };
  }

  const canvas = require('@napi-rs/canvas') as CanvasModule;
  const globals = globalThis as Record<string, unknown>;
  if (!globals.DOMMatrix) globals.DOMMatrix = canvas.DOMMatrix;
  if (!globals.Path2D) globals.Path2D = canvas.Path2D;
  if (!globals.ImageData) globals.ImageData = canvas.ImageData;

  cachedCanvas = canvas;
  cachedPdfjs = require('pdfjs-dist/legacy/build/pdf.js') as PdfjsModule;
  return { pdfjs: cachedPdfjs, canvas: cachedCanvas };
}

function standardFontDataUrl(): string {
  const packageDir = path.dirname(require.resolve('pdfjs-dist/package.json'));
  return path.join(packageDir, 'standard_fonts') + path.sep;
}

/**
 * Um PDF aberto uma única vez, para ler a camada de texto e, quando ela vier
 * vazia, rasterizar a mesma página para o OCR sem reparsear o arquivo.
 *
 * Quem abre é responsável por chamar `close()`.
 */
export class PdfDocumentReader {
  private constructor(private readonly document: PdfDocument) {}

  static async open(content: Buffer): Promise<PdfDocumentReader> {
    const { pdfjs } = loadPdfjs();
    const document = await pdfjs.getDocument({
      data: new Uint8Array(content),
      useWorkerFetch: false,
      isEvalSupported: false,
      standardFontDataUrl: standardFontDataUrl(),
      verbosity: 0,
    }).promise;
    return new PdfDocumentReader(document);
  }

  get pageCount(): number {
    return this.document.numPages;
  }

  async textLayer(): Promise<ExtractedPage[]> {
    const pages: ExtractedPage[] = [];
    for (let pageNumber = 1; pageNumber <= this.document.numPages; pageNumber += 1) {
      const page = await this.document.getPage(pageNumber);
      const content = await page.getTextContent();
      const text = content.items
        .map((item) => (item.str ?? '') + (item.hasEOL ? '\n' : ''))
        .join('');
      page.cleanup();
      pages.push({ pageNumber, text });
    }
    return pages;
  }

  async renderPageToPng(pageNumber: number, scale: number): Promise<Buffer> {
    const { canvas } = loadPdfjs();
    const page = await this.document.getPage(pageNumber);
    const viewport = page.getViewport({ scale });
    const surface = canvas.createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const context = surface.getContext('2d') as CanvasRenderingContext2D;
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, viewport.width, viewport.height);
    await page.render({ canvasContext: context, viewport }).promise;
    page.cleanup();
    return surface.toBuffer('image/png');
  }

  close(): Promise<void> {
    return this.document.destroy();
  }
}
