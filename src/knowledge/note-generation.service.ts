import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OllamaService } from '../ollama/ollama.service';
import {
  DOCUMENT_SUMMARY_SCHEMA,
  DocumentSummary,
  parseDocumentSummary,
} from './note-content';

const DOCUMENT_SUMMARY_SYSTEM = [
  'Você lê documentos de uma agência de publicidade e devolve uma ficha em JSON.',
  'Use apenas o que está no documento; não invente dado que não esteja escrito.',
  'Escreva em português do Brasil, mesmo que o documento esteja em outro idioma.',
  'Responda só com o JSON pedido.',
].join(' ');

export interface DocumentSummaryRequest {
  filename: string;
  scopePath: string;
  excerpt: string;
}

export function buildDocumentSummaryPrompt(request: DocumentSummaryRequest): string {
  return [
    `Arquivo: ${request.filename}`,
    `Pasta: ${request.scopePath}`,
    '',
    'Trecho do documento (partes puladas aparecem como [...]):',
    '"""',
    request.excerpt,
    '"""',
    '',
    'Campos:',
    '- titulo: como o documento se chama, em até uma linha.',
    '- tipo: que espécie de documento é (brand guide, briefing, contrato, planilha de mídia, apresentação...).',
    '- idioma: o idioma predominante do documento, como "pt", "en" ou "es".',
    '- resumo: de duas a cinco frases sobre o que ele diz, com os números e prazos que aparecem.',
    '- topicos: os assuntos tratados, no vocabulário do próprio documento.',
    '- entidades: marcas, produtos, praças e empresas citadas.',
  ].join('\n');
}

@Injectable()
export class NoteGenerationService {
  constructor(
    private readonly config: ConfigService,
    private readonly ollamaService: OllamaService,
  ) {}

  /** O modelo que assina as notas geradas agora. */
  get model(): string {
    return this.ollamaService.textModel;
  }

  async summarizeDocument(request: DocumentSummaryRequest): Promise<DocumentSummary> {
    const raw = await this.ollamaService.generateJson({
      system: DOCUMENT_SUMMARY_SYSTEM,
      prompt: buildDocumentSummaryPrompt(request),
      schema: DOCUMENT_SUMMARY_SCHEMA,
      timeoutMs: this.config.get<number>('knowledge.studyTimeoutMs', 180000),
    });

    return parseDocumentSummary(raw);
  }
}
