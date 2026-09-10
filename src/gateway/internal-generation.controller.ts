import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { InternalAuthGuard } from '../auth/internal-auth.guard';
import { InternalCapabilityGuard } from '../auth/internal-capability.guard';
import { OpenToEveryConsumer, RequiresCapability } from '../auth/internal-capabilities';
import { ConnectionRevisionsService } from './connection-revisions.service';
import { ConnectionTestService } from './connection-test.service';
import { GENERATION_STREAM_CONTRACT_VERSION } from './generation-stream.contract';
import { GenerationService } from './generation.service';
import {
  ConnectionActivationDto,
  ConnectionRevisionSyncDto,
  ConnectionTestDto,
  GenerateDto,
  GENERATION_CONTRACT_VERSION,
} from './generation.dto';
import { FEATURE_SPECS, GENERATION_FEATURES } from './feature-registry';
import { listConnections } from './provider-connection';
import { FALLBACK_ELIGIBLE_KINDS } from './llm-provider.port';
import { OpenAiChatAdapter } from './openai-chat.adapter';
import type { ConsumerApplication } from '../auth/consumer-registry';

/**
 * O que o gateway sabe fazer com imagem hoje.
 *
 * Declarado explicitamente, e não presumido: a descrição de imagem existe e é
 * usada no OCR de slide e de página escaneada. Não há rota de geração
 * multimodal aberta a consumidor, e a análise ortográfica de arte que o PDF
 * menciona para o Niprofe continua fora deste contrato.
 */
export const MULTIMODAL_CAPABILITIES = {
  imageDescription: { implemented: true, exposedToConsumers: false, usedBy: ['ocr-de-ingestao'] },
  imageGeneration: { implemented: false, exposedToConsumers: false, usedBy: [] },
  spellCheckOnArtwork: { implemented: false, exposedToConsumers: false, usedBy: [] },
};

/**
 * O gateway de geração, autenticado pelo token interno do Norman.
 *
 * O token diz que a chamada vem do Norman, não que o usuário por trás dela seja
 * administrador: quem conhece perfil e permissão é o Norman. Aqui se valida o
 * escopo do contrato — operação de uma lista fechada, conexão provisionada por
 * chave, modelo entre os permitidos — e nada de URL, segredo ou prompt de
 * sistema vindo de fora.
 */
@UseGuards(InternalAuthGuard, InternalCapabilityGuard)
@Controller('internal/generation')
export class InternalGenerationController {
  constructor(
    private readonly generationService: GenerationService,
    private readonly connectionTestService: ConnectionTestService,
    private readonly connectionRevisions: ConnectionRevisionsService,
    private readonly adapter: OpenAiChatAdapter,
  ) {}

  /**
   * As capacidades do gateway, para o Norman saber o que pedir sem adivinhar.
   *
   * Conexão sem configuração aparece como indisponível com o nome da variável
   * que falta. Ausência de configuração nunca aparece como sucesso.
   */
  @OpenToEveryConsumer()
  @Get('capabilities')
  async capabilities(@Req() request?: { consumer?: ConsumerApplication }) {
    const consumer = request?.consumer;
    const allowed = consumer?.features?.length
      ? GENERATION_FEATURES.filter((feature) => consumer.features.includes(feature))
      : GENERATION_FEATURES;

    return {
      contractVersion: GENERATION_CONTRACT_VERSION,
      streamContractVersion: GENERATION_STREAM_CONTRACT_VERSION,
      application: consumer?.name ?? 'norman',
      allowedScopes: consumer?.scopes ?? ['client'],
      multimodal: MULTIMODAL_CAPABILITIES,
      features: allowed.map((feature) => ({
        feature,
        usesClientKnowledge: FEATURE_SPECS[feature].usesClientKnowledge,
        clientBinding: FEATURE_SPECS[feature].clientBinding,
        requiresClient: FEATURE_SPECS[feature].requiresClient,
        json: FEATURE_SPECS[feature].json,
      })),
      fallbackEligibleCauses: FALLBACK_ELIGIBLE_KINDS,
      provider: this.adapter.capabilities(),
      connections: await Promise.all(
        listConnections().map(async (connection) => {
          // As revisões reconhecidas entram nas capacidades para o plano de
          // controle saber o que este executor aceita executar. Chave, URL e
          // qualquer parte do segredo continuam fora: o que atravessa é chave
          // lógica, número da revisão e modelo.
          const revisions = (await this.connectionRevisions.describe(connection.key).catch(() => []))
            .map((revision) => ({
              revision: revision.revision,
              model: revision.model,
              isEnabled: revision.isEnabled,
              isActivated: revision.activationIds.length > 0,
              // As identidades confirmadas, e não só "tem ativação": é por elas
              // que o plano de controle reconcilia uma tentativa cujo resultado
              // ele não chegou a ler.
              activationIds: revision.activationIds,
            }));

          return connection.available
            ? {
                key: connection.key,
                label: connection.label,
                protocol: connection.protocol,
                available: true,
                defaultModel: connection.defaultModel,
                allowedModels: connection.allowedModels,
                recognizedRevisions: revisions,
              }
            : {
                key: connection.key,
                label: connection.label,
                protocol: connection.protocol,
                available: false,
                reason: connection.reason,
                recognizedRevisions: revisions,
              };
        }),
      ),
    };
  }

  /**
   * Reconhece uma revisão de conexão, de forma idempotente.
   *
   * Recebe chave lógica, número da revisão e modelo — nunca URL nem segredo. O
   * modelo é validado contra a allowlist **deste** executor: a allowlist do
   * plano de controle aprovaria modelo que aqui não existe.
   */
  @RequiresCapability('connections.administer')
  @Post('connections/revisions')
  syncRevision(@Body() dto: ConnectionRevisionSyncDto) {
    return this.connectionRevisions.sync(dto);
  }

  /**
   * Confirma uma ativação para a tupla exata identidade + chave + revisão.
   *
   * É o lado do executor no protocolo de preparação e confirmação: o plano de
   * controle cria a identidade, chama esta rota e só depois torna a ativação
   * vigente. Sem esta gravação, `activationId` era um campo de auditoria que
   * qualquer corpo podia inventar.
   *
   * Idempotente pela mesma tupla, para uma repetição depois de timeout descobrir
   * que a confirmação já havia acontecido em vez de duplicá-la. A confirmação
   * nova nunca apaga uma anterior válida.
   */
  @RequiresCapability('connections.administer')
  @Post('connections/activations')
  confirmActivation(@Body() dto: ConnectionActivationDto) {
    return this.connectionRevisions.confirmActivation(dto);
  }

  /**
   * A confirmação de uma identidade de ativação, para reconciliação.
   *
   * Um timeout não diz se a confirmação aconteceu, e presumir que não aconteceu
   * é o que deixaria os dois lados divergentes. Esta leitura responde a pergunta
   * sem repetir a operação: 404 é ausência de confirmação, e não incerteza.
   */
  @RequiresCapability('connections.administer')
  @Get('connections/activations/:activationId')
  async describeActivation(@Param('activationId') activationId: string) {
    const confirmada = await this.connectionRevisions.findActivation(activationId);
    if (!confirmada) {
      throw new NotFoundException(
        `a ativação "${activationId}" não está confirmada neste backend`,
      );
    }
    return confirmada;
  }

  /**
   * A mesma geração, entregue conforme sai do provedor.
   *
   * Cada evento é uma linha `data:` com o tipo dentro, e a versão do contrato
   * de fluxo vai no primeiro evento: um consumidor que não a conheça para na
   * abertura em vez de interpretar eventos que não entende.
   *
   * Quem responde pelo abandono é a **resposta**, não a requisição: em Node,
   * `req` emite `close` quando o corpo da requisição terminou de ser lido, o que
   * acontece em toda chamada normal. Observar ali cancelaria a geração de todo
   * mundo. `res.on('close')` — e o socket, como reforço — é que dizem que o
   * consumidor foi embora antes de a resposta terminar.
   *
   * `req.on('aborted')` fica só para o corpo da requisição interrompido, que é
   * outra coisa e também precisa parar o provedor.
   */
  @OpenToEveryConsumer()
  @Post('v1/stream')
  async stream(
    @Body() dto: GenerateDto,
    @Res() response: Response,
    @Req() request?: {
      consumer?: ConsumerApplication;
      on?: (evento: string, ouvinte: () => void) => void;
      off?: (evento: string, ouvinte: () => void) => void;
    },
  ): Promise<void> {
    this.assertConsumerMayGenerate(dto, request?.consumer);

    const controller = new AbortController();
    let finished = false;

    // Conclusão normal não é cancelamento: `res` também emite `close` depois do
    // `end()`, e sem esta trava a resposta bem-sucedida seria contada como
    // abandono do consumidor.
    const abandon = () => {
      if (!finished) controller.abort();
    };
    const abortedBody = () => controller.abort();

    response.on('close', abandon);
    (response as unknown as { socket?: { on?: Function; off?: Function } }).socket?.on?.(
      'close',
      abandon,
    );
    request?.on?.('aborted', abortedBody);

    // Os ouvintes saem no fim: um socket keep-alive atende várias respostas, e
    // acumular ouvintes nele reteria o `AbortController` de cada uma.
    const releaseListeners = () => {
      response.off?.('close', abandon);
      (response as unknown as { socket?: { off?: Function } }).socket?.off?.('close', abandon);
      request?.off?.('aborted', abortedBody);
    };

    response.setHeader('Content-Type', 'text/event-stream');
    response.setHeader('Cache-Control', 'no-cache');
    response.setHeader('Connection', 'keep-alive');
    response.flushHeaders?.();

    const write = (payload: unknown) => {
      response.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    write({ type: 'open', contractVersion: GENERATION_STREAM_CONTRACT_VERSION });

    try {
      for await (const event of this.generationService.generateStream(dto, controller.signal)) {
        write(event);
      }
      finished = true;
    } catch (error) {
      finished = true;
      // Cancelamento do consumidor não é falha do provedor, e registrá-lo como
      // tal misturaria abandono com indisponibilidade na tela e na auditoria.
      write(
        controller.signal.aborted
          ? {
              type: 'failed',
              correlationId: dto.correlationId,
              feature: dto.feature,
              failureKind: 'cancelled',
              reason: 'o consumidor fechou a conexão antes de a geração terminar',
              streamed: false,
              attempts: [],
            }
          : {
              type: 'failed',
              correlationId: dto.correlationId,
              feature: dto.feature,
              failureKind: 'provider_error',
              reason: error instanceof Error ? error.message : 'a geração não pôde ser iniciada',
              streamed: false,
              attempts: [],
            },
      );
    } finally {
      finished = true;
      releaseListeners();
      response.end();
    }
  }

  /**
   * Testa uma conexão provisionada pelo mesmo caminho da geração real.
   *
   * Quem chama manda a chave lógica e a revisão, nunca URL, modelo livre ou
   * segredo. O teste feito do outro lado provava outra coisa — outra rede,
   * outra biblioteca, outro conjunto de variáveis — e uma conexão aprovada lá
   * podia falhar aqui.
   */
  @RequiresCapability('connections.administer')
  @Post('connections/test')
  testConnection(@Body() dto: ConnectionTestDto) {
    return this.connectionTestService.test(dto);
  }

  /**
   * Gera pelo contrato interno, no escopo que a aplicação pode usar.
   *
   * A aplicação vem do token, não do corpo: um consumidor novo não herda as
   * operações do Norman nem alcança conhecimento de cliente sem ter esse escopo
   * declarado. É o que mantém o isolamento de pessoa/organização deste backend
   * intacto quando outro produto passa a reutilizar o gateway.
   */
  @OpenToEveryConsumer()
  @Post('v1/complete')
  complete(@Body() dto: GenerateDto, @Req() request?: { consumer?: ConsumerApplication }) {
    this.assertConsumerMayGenerate(dto, request?.consumer);
    return this.generationService.generate(dto);
  }

  private assertConsumerMayGenerate(dto: GenerateDto, consumer?: ConsumerApplication): void {
    if (consumer?.features?.length && !consumer.features.includes(dto.feature)) {
      throw new ForbiddenException(
        `a aplicação "${consumer.name}" não pode pedir a operação "${dto.feature}"`,
      );
    }
    if (dto.clientId && consumer && !consumer.scopes.includes('client')) {
      throw new ForbiddenException(
        `a aplicação "${consumer.name}" não alcança conhecimento por cliente`,
      );
    }
  }
}
