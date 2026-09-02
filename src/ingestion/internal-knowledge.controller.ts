import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { InternalAuthGuard } from '../auth/internal-auth.guard';
import { DocumentChunksService } from '../documents/document-chunks.service';
import { OllamaService } from '../ollama/ollama.service';
import { KnowledgeSearchDto } from './internal-documents.dto';

@UseGuards(InternalAuthGuard)
@Controller('internal/knowledge')
export class InternalKnowledgeController {
  constructor(
    private readonly documentChunksService: DocumentChunksService,
    private readonly ollamaService: OllamaService,
  ) {}

  /**
   * Os trechos do acervo de um cliente relevantes para uma pergunta.
   *
   * Recupera só dos níveis ancestrais de `scopePath` e só do cliente informado —
   * é `searchSimilar` no escopo de cliente que garante isso, e nada aqui afrouxa.
   * Devolve lista vazia quando não há o que recuperar; quem chama trata vazio
   * como "não há conhecimento", nunca como erro.
   */
  @Post('search')
  async search(@Body() dto: KnowledgeSearchDto) {
    const embedding = await this.ollamaService.embed(dto.question);
    const snippets = await this.documentChunksService.searchSimilar({
      scope: { kind: 'client', clientId: dto.clientId, scopePath: dto.scopePath },
      embedding,
    });
    return { snippets };
  }
}
