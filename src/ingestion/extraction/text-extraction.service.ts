import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OllamaVisionService } from '../../ollama/ollama-vision.service';
import { extractDocx } from './docx.extractor';
import { extractDoc } from './doc.extractor';
import { extractXlsx } from './xlsx.extractor';
import { extractXls } from './xls.extractor';
import { PptxReader } from './pptx.extractor';
import { PdfDocumentReader } from './pdf.extractor';
import {
  DocumentKind,
  DocumentTooLargeError,
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
   * Lança `UnsupportedDocumentTypeError` para tipo que não sabe ler,
   * `DocumentTooLargeError` acima do teto de tamanho, `ProtectedDocumentError`
   * para arquivo cifrado, `MalformedDocumentError` para arquivo corrompido e
   * `EmptyExtractionError` quando o arquivo é legível mas não sobrou texto
   * nenhum. Nunca devolve lista vazia: documento sem texto tem que virar
   * `failed`, não um sucesso mudo que entra no acervo sem conteúdo.
   */
  async extract(input: ExtractTextInput): Promise<ExtractedDocument> {
    const kind: DocumentKind = detectDocumentKind(input.filename, input.mimeType);

    const maxBytes = this.config.get<number>('ingestion.maxFileBytes', 104857600);
    if (input.content.length > maxBytes) {
      throw new DocumentTooLargeError(
        `${input.filename} tem ${input.content.length} bytes, acima do teto de ${maxBytes}`,
      );
    }

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
    if (kind === 'doc') {
      return { pages: await extractDoc(content), source: 'doc' };
    }
    if (kind === 'xlsx') {
      return { pages: await extractXlsx(content), source: 'xlsx' };
    }
    if (kind === 'xls') {
      const maxSheets = this.config.get<number>('ingestion.maxSheets', 100);
      return { pages: await extractXls(content, maxSheets), source: 'xls' };
    }
    if (kind === 'pptx') {
      return this.extractPptx(content);
    }
    if (kind === 'image') {
      return this.extractImage(content);
    }
    if (kind === 'plain') {
      return { pages: [{ pageNumber: null, text: content.toString('utf8') }], source: 'plain' };
    }
    return this.extractPdf(content);
  }

  /**
   * Um slide por página, com OCR das imagens do slide quando o texto próprio
   * dele vem curto demais.
   *
   * Deck de agência costuma ser arte exportada: sem o OCR das imagens, um slide
   * inteiro entraria vazio e o documento sumiria do acervo mesmo tendo conteúdo
   * na tela. O teto de imagens existe porque cada chamada de visão custa mais de
   * um minuto nesta máquina.
   */
  private async extractPptx(content: Buffer): Promise<ExtractedDocument> {
    const reader = await PptxReader.open(
      content,
      this.config.get<number>('ingestion.maxExpandedFileBytes', 314572800),
    );
    const slides = await reader.slides(this.config.get<number>('ingestion.maxSlides', 300));

    let ocrBudget = this.config.get<number>('ingestion.slideOcrMaxImages', 20);
    let usedOcr = false;
    const pages: ExtractedPage[] = [];

    for (const slide of slides) {
      const ownText = normalizeExtractedText(slide.text);
      const transcriptions: string[] = [];

      if (ownText.length < MIN_CHARS_PER_PAGE) {
        for (const part of slide.imageParts) {
          if (ocrBudget <= 0) break;
          ocrBudget -= 1;

          const image = await reader.readImagePart(part);
          if (!image) continue;

          const transcribed = await this.transcribeImage(image, `slide ${slide.slideNumber}`);
          if (transcribed.length > 0) transcriptions.push(transcribed);
        }
      }

      if (transcriptions.length > 0) usedOcr = true;

      pages.push({
        pageNumber: slide.slideNumber,
        text: [ownText, ...transcriptions].filter((part) => part.length > 0).join('\n'),
      });
    }

    return { pages, source: usedOcr ? 'pptx-ocr' : 'pptx' };
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
      return await this.transcribeImage(image, `página ${pageNumber}`);
    } catch (error) {
      this.logger.warn(
        `OCR da página ${pageNumber} falhou: ${error instanceof Error ? error.message : error}`,
      );
      return '';
    }
  }

  /**
   * O texto de um arquivo de imagem.
   *
   * A falha do modelo de visão **não** é engolida aqui, ao contrário do OCR de
   * página de PDF e de imagem de slide: lá a imagem é uma melhoria de uma
   * página, e perder uma não invalida o documento; aqui ela é o documento
   * inteiro. Reportar "sem texto" quando o que houve foi o modelo não responder
   * mandaria a pessoa procurar conteúdo onde o problema é de infraestrutura.
   *
   * Imagem sem texto legível continua virando documento vazio, e quem chama a
   * recusa: foto de produto não é conhecimento.
   */
  private async extractImage(content: Buffer): Promise<ExtractedDocument> {
    const transcription = await this.vision.transcribeImage(content, {
      timeoutMs: this.config.get<number>('ingestion.ocrTimeoutMs', 180000),
    });
    return {
      pages: [{ pageNumber: null, text: normalizeExtractedText(transcription) }],
      source: 'image-ocr',
    };
  }

  /**
   * A transcrição de uma imagem pelo modelo de visão, ou vazio se ela falhar.
   *
   * A falha é engolida de propósito: OCR é melhoria de uma página, e derrubar a
   * extração inteira por causa de uma imagem perderia o texto que já foi lido.
   */
  private async transcribeImage(image: Buffer, label: string): Promise<string> {
    try {
      const transcription = await this.vision.transcribeImage(image, {
        timeoutMs: this.config.get<number>('ingestion.ocrTimeoutMs', 180000),
      });
      return normalizeExtractedText(transcription);
    } catch (error) {
      this.logger.warn(
        `OCR de ${label} falhou: ${error instanceof Error ? error.message : error}`,
      );
      return '';
    }
  }
}
