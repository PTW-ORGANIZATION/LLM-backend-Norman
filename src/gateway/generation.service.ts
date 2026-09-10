import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DocumentChunksService } from '../documents/document-chunks.service';
import { KnowledgeNoteKind } from '../knowledge/knowledge-note.entity';
import { KnowledgeNotesService } from '../knowledge/knowledge-notes.service';
import { applyRetrievalBudget, type RetrievalBudget } from '../knowledge/retrieval-budget';
import {
  mergeKnowledgeLayers,
  type LayeredEvidence,
} from '../knowledge/layered-retrieval';
import { CLIENT_SCOPE, SYSTEM_SCOPE } from '../documents/knowledge-scope';
import type { RetrievedChunk, SearchScope } from '../documents/document-chunks.service';
import { OllamaService } from '../ollama/ollama.service';
import { GenerationExecution } from './generation-execution.entity';
import { renderBrandTokensBlock, type BrandTokenSet } from './brand-tokens';
import { featureSpec, type FeatureSpec } from './feature-registry';
import { renderInsightsPrompt, renderWorkflowBriefingPrompt } from './feature-payloads';
import { decideFallback, FALLBACK_DISABLED, type FallbackPolicy } from './fallback-policy';
import {
  ProviderFailure,
  type GenerationMessage,
  type LlmProvider,
  type ProviderFailureKind,
} from './llm-provider.port';
import type { GenerationStreamEvent } from './generation-stream.contract';
import { LLM_PROVIDER } from './llm-provider.token';
import { ConnectionRevisionsService } from './connection-revisions.service';
import { resolveConnection, type ResolvedConnection } from './provider-connection';
import type { GenerateDto } from './generation.dto';

export interface GenerationAttemptReport {
  attempt: number;
  connectionKey: string;
  /** A revisão que executou esta tentativa, não a que veio no corpo. */
  connectionRevision: number;
  model: string;
  status: 'succeeded' | 'failed';
  failureKind: ProviderFailureKind | null;
  failureReason: string | null;
  durationMs: number;
  fallbackOf: string | null;
}

export interface GenerationOutcome {
  text: string;
  correlationId: string;
  feature: string;
  usedConnectionKey: string;
  usedConnectionRevision: number;
  usedModel: string;
  attempts: GenerationAttemptReport[];
  citations: Array<{
    /**
     * De qual camada este trecho veio: `client` ou `system`.
     *
     * A citação sem a camada deixava a resposta ambígua no ponto que mais
     * importa — uma cor citada de uma regra geral do sistema e a mesma cor
     * citada do acervo do cliente têm consequências diferentes para quem lê.
     */
    scope: 'system' | 'client';
    documentId: string;
    filename: string | null;
    storagePath: string | null;
    chunkIndex: number;
    pageNumber: number | null;
    similarity: number;
  }>;
  evidence: LayeredEvidence | null;
  knowledgeUnavailable: boolean;
  /** Falso quando a camada geral do sistema ficou fora desta geração. */
  systemKnowledgeAvailable: boolean;
  dossierState: 'current' | 'stale' | 'absent';
}

const CONTEXT_HEADER =
  'Contexto autorizado (use apenas o que for pertinente). Cada trecho vem marcado com a camada '
  + 'de origem: [cliente] é conhecimento privado deste cliente e [sistema] é conhecimento geral '
  + 'do Norman. Quando as duas se contradisserem, vale a do cliente:';

/**
 * O aviso de que a camada geral ficou fora desta geração.
 *
 * Ele existe para a resposta não afirmar ausência de regra geral quando o que
 * houve foi indisponibilidade dela: o conhecimento do cliente continua valendo,
 * e o modelo precisa saber que a outra camada não pôde ser consultada.
 */
const SYSTEM_KNOWLEDGE_UNAVAILABLE =
  'A camada de conhecimento geral do Norman não pôde ser consultada agora. O conhecimento deste '
  + 'cliente continua valendo. Não afirme que não existe regra geral e não invente nenhuma.';

const KNOWLEDGE_UNAVAILABLE =
  'Consulta ao acervo do cliente indisponível agora. Se a resposta depender do conhecimento do ' +
  'cliente, diga que não foi possível consultar o acervo. Não afirme ausência e não invente ' +
  'regra, cor, fonte ou padrão.';

const DOSSIER_UNAVAILABLE =
  'O resumo consolidado do cliente não está disponível agora. Não presuma cores, fontes, tom de ' +
  'voz ou restrições a partir de memória.';

/**
 * Um trecho, com a camada de origem antes do arquivo.
 *
 * A camada vem primeiro de propósito: quem lê o contexto precisa saber de que
 * nível a afirmação veio antes de saber de que arquivo.
 */
function renderSnippet(snippet: RetrievedChunk): string {
  const camada = snippet.knowledgeScope === SYSTEM_SCOPE ? 'sistema' : 'cliente';
  const origem = [snippet.filename, snippet.pageNumber ? `página ${snippet.pageNumber}` : '']
    .filter(Boolean)
    .join(', ');
  return origem
    ? `- [${camada} | ${origem}] ${snippet.content}`
    : `- [${camada}] ${snippet.content}`;
}

/**
 * A orquestração de geração: contexto, provedor, fallback e registro.
 *
 * O prompt privilegiado vem do registro de operações, nunca da requisição. A
 * conexão vem por chave, resolvida somente entre as provisionadas. O acervo é
 * consultado aqui, com o `clientId` que o Norman já autorizou, e o resultado da
 * consulta entra no prompt com a procedência de cada trecho.
 */
@Injectable()
export class GenerationService {
  private readonly logger = new Logger(GenerationService.name);

  constructor(
    private readonly config: ConfigService,
    @Inject(LLM_PROVIDER)
    private readonly provider: LlmProvider,
    private readonly ollamaService: OllamaService,
    private readonly documentChunksService: DocumentChunksService,
    private readonly knowledgeNotesService: KnowledgeNotesService,
    @InjectRepository(GenerationExecution)
    private readonly executions: Repository<GenerationExecution>,
    private readonly revisions: ConnectionRevisionsService,
  ) {}

  async generate(dto: GenerateDto): Promise<GenerationOutcome> {
    const prepared = await this.prepare(dto);
    return this.runWithFallback(prepared);
  }

  /**
   * A mesma geração, entregue conforme sai do provedor.
   *
   * Os metadados finais — provedor, modelo, tentativas, citações e evidências —
   * saem num evento próprio, nunca dentro do texto: o acumulado dos deltas
   * precisa ser exatamente a resposta.
   *
   * O fallback só existe antes do primeiro pedaço. Depois dele, a resposta
   * termina com estado explícito: quem já entregou texto para a tela não troca
   * de provedor no meio e concatena duas respostas.
   */
  async *generateStream(
    dto: GenerateDto,
    signal?: AbortSignal,
  ): AsyncGenerator<GenerationStreamEvent, void, void> {
    const prepared = await this.prepare(dto);
    const policy = this.policyOf(dto);
    const attempts: GenerationAttemptReport[] = [];

    let connection = prepared.primary;
    let currentModel = prepared.model;
    let currentRevision = prepared.revision.revision;
    let fallbackOf: string | null = null;
    let lastFailure: ProviderFailure | null = null;

    for (let attempt = 1; attempt <= Math.max(1, policy.maxAttempts); attempt += 1) {
      const startedAt = Date.now();
      let streamed = false;
      let promptTokens: number | null = null;
      let completionTokens: number | null = null;

      try {
        const events = this.provider.generateStream(connection, {
          model: currentModel,
          messages: prepared.messages,
          temperature: dto.params?.temperature ?? prepared.spec.defaults.temperature,
          maxTokens: dto.params?.maxTokens ?? prepared.spec.defaults.maxTokens,
          json: prepared.spec.json,
          timeoutMs: this.config.get<number>('gateway.timeoutMs', 120000),
          signal,
        });

        for await (const event of events) {
          if (event.kind === 'delta') {
            streamed = true;
            yield { type: 'delta', text: event.text };
            continue;
          }
          promptTokens = event.promptTokens;
          completionTokens = event.completionTokens;
        }

        const report: GenerationAttemptReport = {
          attempt,
          connectionKey: connection.key,
          connectionRevision: currentRevision,
          model: currentModel,
          status: 'succeeded',
          failureKind: null,
          failureReason: null,
          durationMs: Date.now() - startedAt,
          fallbackOf,
        };
        attempts.push(report);
        await this.record(dto, report, prepared.context, promptTokens, completionTokens, currentRevision);

        yield {
          type: 'completed',
          correlationId: dto.correlationId,
          feature: dto.feature,
          usedConnectionKey: connection.key,
          usedConnectionRevision: currentRevision,
          usedModel: currentModel,
          attempts,
          citations: prepared.context.citations,
          evidence: prepared.context.evidence,
          knowledgeUnavailable: prepared.context.knowledgeUnavailable,
          systemKnowledgeAvailable: prepared.context.systemKnowledgeAvailable,
          dossierState: prepared.context.dossierState,
          promptTokens,
          completionTokens,
        };
        return;
      } catch (error) {
        const failure = error instanceof ProviderFailure
          ? error
          : new ProviderFailure('provider_error', this.reasonOf(error));
        lastFailure = failure;

        const report: GenerationAttemptReport = {
          attempt,
          connectionKey: connection.key,
          connectionRevision: currentRevision,
          model: currentModel,
          status: 'failed',
          failureKind: failure.kind,
          failureReason: failure.message,
          durationMs: Date.now() - startedAt,
          fallbackOf,
        };
        attempts.push(report);
        await this.record(dto, report, prepared.context, null, null, currentRevision);

        const decision = decideFallback({
          policy,
          failure: failure.kind,
          attemptsSoFar: attempt,
          primaryKey: prepared.primary.key,
          streamed,
        });
        if (!decision.allowed) {
          yield {
            type: 'failed',
            correlationId: dto.correlationId,
            feature: dto.feature,
            failureKind: failure.kind,
            reason: failure.message,
            streamed,
            attempts,
          };
          return;
        }

        const alternative = await this.resolveFallbackTarget(decision);
        if (!alternative) {
          yield {
            type: 'failed',
            correlationId: dto.correlationId,
            feature: dto.feature,
            failureKind: failure.kind,
            reason: failure.message,
            streamed,
            attempts,
          };
          return;
        }

        fallbackOf = connection.key;
        connection = alternative.connection;
        currentModel = alternative.model;
        currentRevision = alternative.revision;
      }
    }

    yield {
      type: 'failed',
      correlationId: dto.correlationId,
      feature: dto.feature,
      failureKind: lastFailure?.kind ?? 'provider_error',
      reason: lastFailure?.message ?? 'nenhuma tentativa foi possível',
      streamed: false,
      attempts,
    };
  }

  /**
   * A validação, a conexão e o contexto — tudo o que acontece antes de o
   * provedor ser chamado, e que os dois modos de geração fazem igual.
   */
  private async prepare(dto: GenerateDto) {
    const spec = featureSpec(dto.feature);
    if (!spec) throw new BadRequestException(`operação "${dto.feature}" não é aceita pelo gateway`);

    const clientId = String(dto.clientId || '').trim();
    if (spec.requiresClient && !clientId) {
      throw new BadRequestException(`a operação "${dto.feature}" exige cliente`);
    }
    if (!spec.usesClientKnowledge && clientId) {
      throw new BadRequestException(
        `a operação "${dto.feature}" é genérica e não consulta conhecimento de cliente`,
      );
    }

    // Escopo sem cliente é pedido malformado, e atendê-lo pela metade esconderia
    // o erro: `clientId` é a única trava de isolamento da consulta ao acervo, e
    // sem ele não há de quem é o caminho pedido.
    if (!clientId && this.declaresClientScope(dto)) {
      throw new BadRequestException(
        'escopo de acervo foi informado sem cliente; o cliente é a trava do isolamento',
      );
    }

    if (dto.brandTokens && dto.brandTokens.clientId !== clientId) {
      throw new BadRequestException(
        'os tokens de marca pertencem a outro cliente e não compõem este contexto',
      );
    }

    // A revisão manda: chave, número, modelo e ativação são resolvidos no
    // registro deste executor antes de qualquer chamada ao provedor. Executar
    // por `connectionKey` e deixar a revisão como campo de auditoria fazia a
    // revisão 2 rodar em silêncio com a configuração da revisão 1.
    const resolved = await this.revisions.require({
      connectionKey: dto.activation.connectionKey,
      revision: dto.activation.connectionRevision,
      ...(dto.activation.model ? { model: dto.activation.model } : {}),
      activationId: dto.activation.activationId,
    });

    const primary = resolved.connection;
    const model = resolved.record.model;
    const context = await this.buildContext(spec, dto, clientId);
    const messages = this.composeMessages(spec, context.blocks, dto);

    return { dto, spec, primary, model, messages, context, revision: resolved.record };
  }

  private declaresClientScope(dto: GenerateDto): boolean {
    return Boolean(
      String(dto.scopePath || '').trim()
      || dto.excludeScopePaths?.length
      || String(dto.retrievalQuestion || '').trim()
      || dto.brandTokens
      || dto.includeDescendants,
    );
  }

  /**
   * A conexão de fallback, na revisão exata que a política fixou.
   *
   * Resolvida pelo mesmo registro da geração primária, com a revisão e o modelo
   * que vieram na política — nunca "a revisão habilitada mais nova" da chave
   * lógica. Enquanto era a mais nova, sincronizar uma revisão para testá-la já
   * mudava o destino do fallback: a indisponibilidade do primário executava uma
   * configuração que ninguém tinha aprovado.
   *
   * Revisão inexistente, desabilitada, com modelo divergente, com digest de
   * provisionamento alterado ou conexão indisponível recusam o fallback aqui,
   * antes de o provedor externo ser chamado.
   */
  private async resolveFallbackTarget(decision: {
    connectionKey: string;
    connectionRevision: number;
    model: string;
  }): Promise<{
    connection: Extract<ResolvedConnection, { available: true }>;
    model: string;
    revision: number;
  } | null> {
    const connection = resolveConnection(decision.connectionKey);
    if (!connection.available) {
      this.logger.warn(`Fallback para ${decision.connectionKey} não aconteceu: ${connection.reason}`);
      return null;
    }

    try {
      const resolved = await this.revisions.require({
        connectionKey: connection.key,
        revision: decision.connectionRevision,
        model: decision.model,
      });
      return {
        connection: resolved.connection,
        model: resolved.record.model,
        revision: resolved.record.revision,
      };
    } catch (error) {
      this.logger.warn(
        `Fallback para ${connection.key} revisão ${decision.connectionRevision} não aconteceu: ` +
          this.reasonOf(error),
      );
      return null;
    }
  }

  private async buildContext(spec: FeatureSpec, dto: GenerateDto, clientId: string) {
    const blocks: string[] = [];
    let evidence: LayeredEvidence | null = null;
    let dossierState: 'current' | 'stale' | 'absent' = 'absent';
    let citations: GenerationOutcome['citations'] = [];

    if (!spec.usesClientKnowledge || !clientId) {
      return {
        blocks,
        evidence,
        knowledgeUnavailable: false,
        systemKnowledgeAvailable: false,
        dossierState,
        citations,
      };
    }

    const clientHeld = dto.knowledgeUnavailable === true;
    const systemHeld = dto.systemKnowledgeUnavailable === true;
    let clientUnavailable = clientHeld;
    let systemUnavailable = systemHeld;

    if (!clientHeld) {
      const dossier = await this.knowledgeNotesService
        .findClientNote(clientId, KnowledgeNoteKind.CLIENT_DOSSIER)
        .catch((error) => {
          this.logger.warn(`Não consegui ler o dossiê de ${clientId}: ${this.reasonOf(error)}`);
          return undefined;
        });

      if (dossier === undefined) {
        clientUnavailable = true;
      } else if (!dossier) {
        dossierState = 'absent';
      } else if (dossier.staleSince) {
        dossierState = 'stale';
        blocks.push(DOSSIER_UNAVAILABLE);
      } else {
        dossierState = 'current';
        blocks.push(`Resumo consolidado do cliente:\n${JSON.stringify(dossier.content)}`);
      }

      const brandBlock = renderBrandTokensBlock(dto.brandTokens as BrandTokenSet | undefined);
      if (brandBlock) blocks.push(brandBlock);
    }

    // Sem `scopePath`, a consulta é do cliente inteiro — e não "nenhuma
    // consulta". A raiz presumida pela identidade do cliente é o que fazia
    // cliente com espaço, `&`, acento ou underscore receber acervo vazio: os
    // chunks dele estavam gravados sob outra grafia legítima.
    const question = String(dto.retrievalQuestion || '').trim();
    const scopePath = String(dto.scopePath || '').trim();

    if (question && !(clientUnavailable && systemUnavailable)) {
      const budget = this.retrievalBudget();
      const embedding = await this.embedQuestion(question);

      if (!embedding) {
        clientUnavailable = true;
        systemUnavailable = true;
      } else {
        const embeddingModel = this.config.get<string>(
          'ollama.embeddingModel',
          'nomic-embed-text',
        );

        const client = clientUnavailable
          ? { failed: false, chunks: null }
          : await this.searchLayer(`acervo de ${clientId}`, {
              kind: 'client',
              clientId,
              ...(scopePath ? { scopePath } : {}),
              includeDescendants: dto.includeDescendants,
              excludeScopePaths: dto.excludeScopePaths,
            }, embedding, embeddingModel);

        const system = systemUnavailable
          ? { failed: false, chunks: null }
          : await this.searchLayer('acervo geral do sistema', { kind: 'system' }, embedding, embeddingModel);

        if (client.failed) clientUnavailable = true;
        if (system.failed) systemUnavailable = true;

        // O limiar de evidência e o orçamento valem por camada, antes da
        // mesclagem: sem isso, um acervo geral grande gastaria o orçamento com
        // trechos fracos e empurraria para fora a regra do próprio cliente.
        const merged = mergeKnowledgeLayers({
          client: client.chunks ? applyRetrievalBudget(client.chunks, budget) : null,
          system: system.chunks ? applyRetrievalBudget(system.chunks, budget) : null,
          budget,
          systemAvailable: !systemUnavailable,
        });

        evidence = merged.evidence;
        citations = merged.snippets.map((snippet) => ({
          scope: snippet.knowledgeScope,
          documentId: snippet.documentId,
          filename: snippet.filename,
          storagePath: snippet.storagePath,
          chunkIndex: snippet.chunkIndex,
          pageNumber: snippet.pageNumber,
          similarity: snippet.similarity,
        }));
        if (merged.snippets.length > 0) {
          blocks.push(
            `${CONTEXT_HEADER}\n${merged.snippets.map((snippet) => renderSnippet(snippet)).join('\n')}`,
          );
        }
      }
    }

    if (clientUnavailable) blocks.push(KNOWLEDGE_UNAVAILABLE);
    if (systemUnavailable) blocks.push(SYSTEM_KNOWLEDGE_UNAVAILABLE);

    return {
      blocks,
      evidence,
      knowledgeUnavailable: clientUnavailable,
      systemKnowledgeAvailable: !systemUnavailable,
      dossierState,
      citations,
    };
  }

  private async embedQuestion(question: string): Promise<number[] | null> {
    try {
      return await this.ollamaService.embed(question);
    } catch (error) {
      this.logger.warn(`Não consegui vetorizar a pergunta: ${this.reasonOf(error)}`);
      return null;
    }
  }

  private async searchLayer(
    label: string,
    scope: SearchScope,
    embedding: number[],
    embeddingModel: string,
  ): Promise<{ failed: boolean; chunks: RetrievedChunk[] | null }> {
    try {
      return {
        failed: false,
        chunks: await this.documentChunksService.searchSimilar({ scope, embedding, embeddingModel }),
      };
    } catch (error) {
      this.logger.warn(`Busca no ${label} falhou: ${this.reasonOf(error)}`);
      return { failed: true, chunks: null };
    }
  }

  private retrievalBudget(): RetrievalBudget {
    return {
      minSimilarity: this.config.get<number>('knowledge.retrievalMinSimilarity', 0.25),
      maxChars: this.config.get<number>('knowledge.retrievalMaxChars', 8000),
      maxSnippets: this.config.get<number>('knowledge.retrievalMaxSnippets', 5),
    };
  }

  /**
   * As mensagens finais, com o prompt privilegiado sempre na frente.
   *
   * As operações de prompt dinâmico — briefing de entregável e insights — têm o
   * bloco delas montado aqui, a partir dos dados estruturados do pedido. É o
   * que preserva o comportamento do caminho legado sem aceitar instrução
   * privilegiada vinda de quem chama.
   */
  private composeMessages(
    spec: FeatureSpec,
    blocks: string[],
    dto: GenerateDto,
  ): GenerationMessage[] {
    const dinamico = this.dynamicPrompt(spec, dto);
    return [
      { role: 'system' as const, content: spec.systemPrompt },
      ...(dinamico ? [{ role: 'system' as const, content: dinamico }] : []),
      ...blocks.map((content) => ({ role: 'system' as const, content })),
      ...dto.messages.map((message) => ({ role: message.role, content: message.content })),
    ];
  }

  private dynamicPrompt(spec: FeatureSpec, dto: GenerateDto): string {
    if (spec.feature.startsWith('workflow_briefing')) {
      if (!dto.workflowBriefing) {
        throw new BadRequestException(
          `a operação "${spec.feature}" exige as perguntas obrigatórias do entregável`,
        );
      }
      return renderWorkflowBriefingPrompt(dto.workflowBriefing);
    }
    if (spec.feature === 'job_insights') {
      if (!dto.briefingFramework) {
        throw new BadRequestException('a operação "job_insights" exige o briefing estruturado');
      }
      return renderInsightsPrompt(dto.briefingFramework);
    }
    return '';
  }

  private policyOf(dto: GenerateDto): FallbackPolicy {
    if (!dto.fallback?.enabled) return FALLBACK_DISABLED;
    return {
      enabled: true,
      connectionKey: dto.fallback.connectionKey ?? null,
      connectionRevision: Number.isInteger(dto.fallback.connectionRevision)
        ? (dto.fallback.connectionRevision as number)
        : null,
      model: String(dto.fallback.model || '').trim() || null,
      allowedCauses: dto.fallback.allowedCauses as ProviderFailureKind[],
      maxAttempts: dto.fallback.maxAttempts,
    };
  }

  private async runWithFallback(input: {
    dto: GenerateDto;
    spec: FeatureSpec;
    primary: Extract<ResolvedConnection, { available: true }>;
    model: string;
    messages: GenerationMessage[];
    context: Awaited<ReturnType<GenerationService['buildContext']>>;
    revision: { revision: number };
  }): Promise<GenerationOutcome> {
    const { dto, spec, primary, model, messages, context, revision } = input;
    const policy = this.policyOf(dto);
    const attempts: GenerationAttemptReport[] = [];

    let connection = primary;
    let currentModel = model;
    let currentRevision = revision.revision;
    let fallbackOf: string | null = null;
    let lastFailure: ProviderFailure | null = null;

    for (let attempt = 1; attempt <= Math.max(1, policy.maxAttempts); attempt += 1) {
      const startedAt = Date.now();
      try {
        const response = await this.provider.generate(connection, {
          model: currentModel,
          messages,
          temperature: dto.params?.temperature ?? spec.defaults.temperature,
          maxTokens: dto.params?.maxTokens ?? spec.defaults.maxTokens,
          json: spec.json,
          timeoutMs: this.config.get<number>('gateway.timeoutMs', 120000),
        });

        const report: GenerationAttemptReport = {
          attempt,
          connectionKey: connection.key,
          connectionRevision: currentRevision,
          model: currentModel,
          status: 'succeeded',
          failureKind: null,
          failureReason: null,
          durationMs: Date.now() - startedAt,
          fallbackOf,
        };
        attempts.push(report);
        await this.record(dto, report, context, response.promptTokens, response.completionTokens, currentRevision);

        return {
          text: response.text,
          correlationId: dto.correlationId,
          feature: dto.feature,
          usedConnectionKey: connection.key,
          usedConnectionRevision: currentRevision,
          usedModel: currentModel,
          attempts,
          citations: context.citations,
          evidence: context.evidence,
          knowledgeUnavailable: context.knowledgeUnavailable,
          systemKnowledgeAvailable: context.systemKnowledgeAvailable,
          dossierState: context.dossierState,
        };
      } catch (error) {
        const failure = error instanceof ProviderFailure
          ? error
          : new ProviderFailure('provider_error', this.reasonOf(error));
        lastFailure = failure;

        const report: GenerationAttemptReport = {
          attempt,
          connectionKey: connection.key,
          connectionRevision: currentRevision,
          model: currentModel,
          status: 'failed',
          failureKind: failure.kind,
          failureReason: failure.message,
          durationMs: Date.now() - startedAt,
          fallbackOf,
        };
        attempts.push(report);
        await this.record(dto, report, context, null, null, currentRevision);

        const decision = decideFallback({
          policy,
          failure: failure.kind,
          attemptsSoFar: attempt,
          primaryKey: primary.key,
          streamed: false,
        });
        if (!decision.allowed) break;

        const alternative = await this.resolveFallbackTarget(decision);
        if (!alternative) break;

        fallbackOf = connection.key;
        connection = alternative.connection;
        currentModel = alternative.model;
        currentRevision = alternative.revision;
      }
    }

    throw new ServiceUnavailableException(
      `a geração não foi concluída: ${lastFailure?.message ?? 'nenhuma tentativa foi possível'}`,
    );
  }

  /**
   * Registra a tentativa com a revisão que foi realmente resolvida.
   *
   * Não com a que veio no corpo: quando o fallback entra, a segunda tentativa
   * roda sobre outra conexão e outra revisão, e gravar o número recebido faria
   * o registro apontar para uma configuração que não executou nada.
   */
  private async record(
    dto: GenerateDto,
    report: GenerationAttemptReport,
    context: Awaited<ReturnType<GenerationService['buildContext']>>,
    promptTokens: number | null,
    completionTokens: number | null,
    connectionRevision: number,
  ): Promise<void> {
    try {
      const linha = this.executions.create({
        correlationId: dto.correlationId,
        feature: dto.feature,
        clientId: dto.clientId ?? null,
        scopePath: dto.scopePath ?? null,
        actorUserId: dto.actor.userId,
        activationId: dto.activation.activationId,
        connectionKey: report.connectionKey,
        connectionRevision,
        model: report.model,
        attempt: report.attempt,
        fallbackOf: report.fallbackOf,
        status: report.status,
        failureKind: report.failureKind,
        failureReason: report.failureReason,
        durationMs: report.durationMs,
        promptTokens,
        completionTokens,
        evidence: {
          citations: context.citations,
          retrieval: context.evidence ?? null,
          knowledgeUnavailable: context.knowledgeUnavailable,
          // A auditoria distingue as duas camadas: sem isto, uma geração feita
          // sem a camada geral e uma feita com ela ficariam idênticas no
          // registro, e não haveria como saber com que contexto a resposta saiu.
          systemKnowledgeAvailable: context.systemKnowledgeAvailable,
          knowledgeLayers: context.evidence?.layers ?? null,
          dossierState: context.dossierState,
        },
      });
      await this.executions.save(linha);
    } catch (error) {
      this.logger.warn(`Não consegui registrar a execução: ${this.reasonOf(error)}`);
    }
  }

  private reasonOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
