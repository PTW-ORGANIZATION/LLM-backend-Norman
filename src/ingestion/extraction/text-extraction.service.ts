import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OllamaVisionService } from '../../ollama/ollama-vision.service';
import { extractDocx } from './docx.extractor';
import { extractXlsx } from './xlsx.extractor';
import { PdfDocumentReader } from './pdf.extractor';
import {
  DocumentKind,
  EmptyExtractionError,
  ExtractedDocument,
  ExtractedPage,
  detectDocumentKind,
  keepNonEmptyPages,
  normalizeExtractedText,
} from './extracted-text';

const MIN_CHARS_PER_PAGE = 24;

export interface ExtractTextInput {
  content: Buffer;
  filename: string;
  mimeType?: string | null;
}

@Injectable()
export class TextExtractionService {
  private readonly logger = new Logger(TextExtractionService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly vision: OllamaVisionService,
  ) {}

  /**
   * O conteúdo textual de um arquivo do repositório, página a página.
   *
   * Lança `UnsupportedDocumentTypeError` para tipo que não sabe ler e
   * `EmptyExtractionError` quando o arquivo é legível mas não sobrou texto
   * nenhum. Nunca devolve lista vazia: documento sem texto tem que virar
   * `failed`, não um sucesso mudo que entra no acervo sem conteúdo.
   */
  async extract(input: ExtractTextInput): Promise<ExtractedDocument> {
    const kind: DocumentKind = detectDocumentKind(input.filename, input.mimeType);

    const extracted = await this.extractByKind(kind, input.content);
    const pages = keepNonEmptyPages(extracted.pages);

    if (pages.length === 0) {
      throw new EmptyExtractionError(`${input.filename} (${kind})`);
    }

    return { pages, source: extracted.source };
  }

  private async extractByKind(kind: DocumentKind, content: Buffer): Promise<ExtractedDocument> {
    if (kind === 'docx') {
      return { pages: await extractDocx(content), source: 'docx' };
    }
    if (kind === 'xlsx') {
      return { pages: await extractXlsx(content), source: 'xlsx' };
    }
    if (kind === 'plain') {
      return { pages: [{ pageNumber: null, text: content.toString('utf8') }], source: 'plain' };
    }
    return this.extractPdf(content);
  }

  private async extractPdf(content: Buffer): Promise<ExtractedDocument> {
    const reader = await PdfDocumentReader.open(content);
    try {
      const rawPages = await reader.textLayer();
      const pages: ExtractedPage[] = [];
      let ocrBudget = this.config.get<number>('ingestion.ocrMaxPages', 20);
      let usedOcr = false;

      for (const rawPage of rawPages) {
        const pageNumber = rawPage.pageNumber ?? 1;
        const textLayer = normalizeExtractedText(rawPage.text);

        if (textLayer.length >= MIN_CHARS_PER_PAGE || ocrBudget <= 0) {
          pages.push({ pageNumber, text: textLayer });
          continue;
        }

        ocrBudget -= 1;
        const transcribed = await this.transcribePage(reader, pageNumber);
        if (transcribed.length > 0) usedOcr = true;

        pages.push({
          pageNumber,
          text: transcribed.length > textLayer.length ? transcribed : textLayer,
        });
      }

      return { pages, source: usedOcr ? 'pdf-ocr' : 'pdf-text-layer' };
    } finally {
      await reader.close();
    }
  }

  private async transcribePage(reader: PdfDocumentReader, pageNumber: number): Promise<string> {
    try {
      const image = await reader.renderPageToPng(
        pageNumber,
        this.config.get<number>('ingestion.ocrScale', 2),
      );
      const transcription = await this.vision.transcribeImage(image, {
        timeoutMs: this.config.get<number>('ingestion.ocrTimeoutMs', 180000),
      });
      return normalizeExtractedText(transcription);
    } catch (error) {
      this.logger.warn(
        `OCR da página ${pageNumber} falhou: ${error instanceof Error ? error.message : error}`,
      );
      return '';
    }
  }
}
