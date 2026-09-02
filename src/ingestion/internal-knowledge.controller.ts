import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { InternalAuthGuard } from '../auth/internal-auth.guard';
import { DocumentChunksService } from '../documents/document-chunks.service';
import { OllamaService } from '../ollama/ollama.service';
import { KnowledgeNoteKind } from '../knowledge/knowledge-note.entity';
import { KnowledgeNotesService } from '../knowledge/knowledge-notes.service';
import { ClientDossierDto, KnowledgeSearchDto, ScopeStatusDto } from './internal-documents.dto';

@UseGuards(InternalAuthGuard)
@Controller('internal/knowledge')
export class InternalKnowledgeController {
  constructor(
    private readonly documentChunksService: DocumentChunksService,
    private readonly ollamaService: OllamaService,
    private readonly knowledgeNotesService: KnowledgeNotesService,
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

  /**
   * O estado de ingestão de cada arquivo de uma pasta, para a tela do
   * repositório do Norman mostrar ao lado do arquivo.
   *
   * Só a pasta pedida, sem descer: é o que a tela lista. Pasta sem nada ingerido
   * devolve lista vazia, que a tela trata como "nada a mostrar".
   */
  @Post('scope-status')
  async scopeStatus(@Body() dto: ScopeStatusDto) {
    return { documents: await this.knowledgeNotesService.listScopeStatus(dto) };
  }

  /**
   * O dossiê consolidado de um cliente, ou nulo.
   *
   * Nulo é o caso normal de quem ainda não tem acervo estudado, e quem chama
   * trata como "não há dossiê" — nunca como erro. Chaveado só pelo `clientId`:
   * o dossiê é do cliente inteiro, e por isso consultá-lo não exige adivinhar a
   * grafia da pasta.
   */
  @Post('dossier')
  async dossier(@Body() dto: ClientDossierDto) {
    const note = await this.knowledgeNotesService.findClientNote(
      dto.clientId,
      KnowledgeNoteKind.CLIENT_DOSSIER,
    );

    return {
      dossier: note?.content ?? null,
      updatedAt: note?.updatedAt ?? null,
    };
  }
}
