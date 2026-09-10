import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Module } from '@nestjs/common';
import { ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { TypeOrmModule } from '@nestjs/typeorm';
import type { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { toSql } from 'pgvector';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import configuration from '../src/config/configuration';
import { NORMAN_FEATURES } from '../src/auth/consumer-registry';
import { DocumentChunk } from '../src/documents/document-chunk.entity';
import { DocumentRecord } from '../src/documents/document.entity';
import { DocumentChunksService } from '../src/documents/document-chunks.service';
import { DocumentsService } from '../src/documents/documents.service';
import { KnowledgeNote } from '../src/knowledge/knowledge-note.entity';
import { KnowledgeNotesService } from '../src/knowledge/knowledge-notes.service';
import { ConnectionActivation } from '../src/gateway/connection-activation.entity';
import { ConnectionRevision } from '../src/gateway/connection-revision.entity';
import { ConnectionRevisionsService } from '../src/gateway/connection-revisions.service';
import { ConnectionTestService } from '../src/gateway/connection-test.service';
import { GenerationExecution } from '../src/gateway/generation-execution.entity';
import { GenerationService } from '../src/gateway/generation.service';
import { InternalGenerationController } from '../src/gateway/internal-generation.controller';
import { LLM_PROVIDER } from '../src/gateway/llm-provider.token';
import { OpenAiChatAdapter } from '../src/gateway/openai-chat.adapter';
import { OllamaService } from '../src/ollama/ollama.service';
import { startIntegrationPostgres, type EmbeddedPostgres } from '../src/test/embedded-postgres';
import { KNOWLEDGE_MIGRATIONS } from '../src/test/knowledge-migrations';

/**
 * A fronteira real entre o Norman e o executor, com os dois lados de verdade.
 *
 * O que esta suíte prova e nenhuma das duas suítes isoladas provava: que a
 * operação que o adapter do Norman **produz** é a operação que o token do
 * Norman **pode pedir**, e que a identidade de ativação que a trava operacional
 * resolve é uma que o registro do executor reconhece.
 *
 * Os dois defeitos que ela fecha nasceram exatamente dessa lacuna: o adapter
 * trocava `chat` por `chat_generic` sem cliente e levava 403; a trava fabricava
 * `forced:<chave>` e era recusada antes do provedor. Os dois estavam verdes nas
 * suítes separadas.
 *
 * Real aqui: o servidor HTTP do Nest, o `InternalAuthGuard`, o `ValidationPipe`
 * com os DTOs, o controller, o `GenerationService`, o registro de revisões e
 * ativações em PostgreSQL embarcado, o plano de controle do Norman sobre outro
 * PostgreSQL embarcado, e o cliente e o adapter do Norman.
 *
 * Stubado: só os modelos externos — a geração de texto e o cálculo de
 * embedding. Nada de autenticação, validação, autorização ou contrato é
 * simulado, porque foi a duplicação dessas regras num servidor falso que deixou
 * o defeito passar.
 */

const TOKEN_NORMAN = 'token-de-contrato-do-norman';
const TOKEN_RESTRITO = 'token-de-contrato-do-parceiro';
const CLIENTE = 'contrato-acme';
const OUTRO_CLIENTE = 'contrato-rival';
const ESCOPO = 'AcmeCorp';
const MODELO_A = 'llama-local';
const MODELO_B = 'llama-novo';

const AMBIENTE: Record<string, string> = {
  INTERNAL_API_TOKEN: TOKEN_NORMAN,
  INTERNAL_CONSUMERS: 'parceiro:PARCEIRO_CONTRACT_TOKEN:job_insights:person',
  PARCEIRO_CONTRACT_TOKEN: TOKEN_RESTRITO,
  OLLAMA_MODEL: MODELO_A,
  OLLAMA_ALLOWED_MODELS: `${MODELO_A},${MODELO_B}`,
  OPENAI_ALLOWED_MODELS: '',
};

/** O banco do plano de controle do Norman, servido pelo protocolo de fio. */
const normanDb: { atual: any } = { atual: null };

vi.mock('@norman/db', () => ({
  get db() {
    return normanDb.atual!.db;
  },
}));

const { createLlmGatewayClient, GENERIC_FEATURE, GATEWAY_CONTRACT_VERSION } = await import(
  '@norman/modules/ai/llm-gateway.client'
);
const { createGatewayAiAdapter } = await import('@norman/modules/ai/gateway-ai.adapter');
const { startEmbeddedPostgres, createAiControlBaseline, AI_CONTROL_MIGRATIONS } = await import(
  '@norman/test/embedded-postgres'
);
const { aiProviderControlRepository } = await import(
  '@norman/modules/ai-provider-control/ai-provider-control.repository'
);
const { createAiProviderControlService } = await import(
  '@norman/modules/ai-provider-control/ai-provider-control.service'
);

/**
 * O caminho do repositório do Norman, o mesmo que a configuração desta suíte
 * usa. Os arquivos de migration são lidos de lá porque o runner do Norman os
 * procura em `process.cwd()`, que aqui é este backend.
 */
const NORMAN_REPO = process.env.NORMAN_REPO_PATH
  ? path.resolve(process.env.NORMAN_REPO_PATH)
  : path.resolve(__dirname, '..', '..', 'Norman');

/** Aplica as migrations do controle de IA do Norman, o SQL real de cada uma. */
async function aplicarMigrationsDoNorman(pool: { query: (sql: string) => Promise<unknown> }) {
  for (const arquivo of AI_CONTROL_MIGRATIONS) {
    await pool.query(await readFile(path.join(NORMAN_REPO, 'migrations', arquivo), 'utf8'));
  }
}

function embedding(): number[] {
  return Array.from({ length: 768 }, (_, index) => (index % 7) / 10);
}

/** O modelo de texto: o único ponto stubado, depois de toda a validação. */
const provedor = {
  respostas: [] as string[],
  pedidos: [] as Array<{ model: string; messages: Array<{ role: string; content: string }> }>,
};

function provedorStub() {
  return {
    protocol: 'openai_chat',
    capabilities: () => ({
      streaming: true,
      structuredOutput: true,
      vision: false,
      cancellation: true,
    }),
    async generate(_connection: any, request: any) {
      provedor.pedidos.push({ model: request.model, messages: request.messages });
      return {
        text: provedor.respostas.shift() ?? 'resposta do provedor',
        promptTokens: 10,
        completionTokens: 3,
      };
    },
    async *generateStream(_connection: any, request: any) {
      provedor.pedidos.push({ model: request.model, messages: request.messages });
      const texto = provedor.respostas.shift() ?? 'resposta do provedor';
      yield { kind: 'delta' as const, text: texto };
      yield { kind: 'completed' as const, promptTokens: 10, completionTokens: 3 };
    },
  };
}

describe('contrato Norman ↔ LLM-backend, pela rede', () => {
  let executorPg: EmbeddedPostgres;
  let dataSource: DataSource;
  let app: INestApplication;
  let baseUrl: string;
  let ambienteOriginal: Record<string, string | undefined>;
  let cliente: ReturnType<typeof createLlmGatewayClient>;
  let clienteRestrito: ReturnType<typeof createLlmGatewayClient>;
  let controle: ReturnType<typeof createAiProviderControlService>;

  /**
   * O adapter real do Norman, com o escopo que a operação em curso declara.
   *
   * A resolução de ativação vem do plano de controle real: com a trava ligada,
   * é a trava que responde; sem ela, é a ativação vigente.
   */
  function adapter(
    escopo: { clientId?: string | null } = {},
    forcado?: string,
    servicoExplicito?: ReturnType<typeof createAiProviderControlService>,
  ) {
    const servico = servicoExplicito
      ?? (forcado === undefined ? controle : servicoDeControle(forcado));
    return createGatewayAiAdapter({
      client: cliente,
      legacy: {} as any,
      resolveActivation: async () => {
        const snapshot = await servico.activeSnapshot();
        return {
          activationId: snapshot.activationId,
          connectionKey: snapshot.connectionKey,
          connectionRevision: snapshot.connectionRevision,
          model: snapshot.provider.model,
        };
      },
      resolveContext: () => ({
        correlationId: 'corr-de-contrato',
        actor: { userId: 'usuario-1' },
        scope: escopo,
      }),
    });
  }

  function servicoDeControle(forcado?: string) {
    return createAiProviderControlService(
      aiProviderControlRepository,
      forcado ? { NORMAN_AI_FORCE_CONNECTION: forcado } : {},
      {
        describeConnectionsAtExecutor: async () =>
          (await cliente.capabilities()).connections as any,
        syncRevisionAtExecutor: cliente.syncRevision,
        confirmActivationAtExecutor: cliente.confirmActivation,
        describeActivationAtExecutor: cliente.describeActivation,
      } as any,
    );
  }

  async function semearTrecho(clientId: string, conteudo: string, arquivo = 'guia.pdf') {
    const documentos = new DocumentsService(dataSource.getRepository(DocumentRecord));
    const { document } = await documentos.registerClientDocument({
      scope: 'client',
      clientId,
      scopePath: ESCOPO,
      storagePath: `${ESCOPO}/${clientId}-${arquivo}`,
      filename: arquivo,
      sha256: `${clientId}-${arquivo}`.padEnd(64, '0').slice(0, 64),
    });
    await dataSource.query(
      `INSERT INTO document_chunks
         (document_id, knowledge_scope, client_id, scope_path, chunk_index, page_number, content,
          embedding, embedding_model, embedding_dimensions)
       VALUES ($1, 'client', $2, $3, 0, 4, $4, $5::vector, 'nomic-embed-text', 768)`,
      [document.id, clientId, ESCOPO, conteudo, toSql(embedding())],
    );
  }

  beforeAll(async () => {
    ambienteOriginal = {};
    for (const [chave, valor] of Object.entries(AMBIENTE)) {
      ambienteOriginal[chave] = process.env[chave];
      process.env[chave] = valor;
    }

    executorPg = await startIntegrationPostgres({
      entities: [
        DocumentRecord,
        DocumentChunk,
        KnowledgeNote,
        GenerationExecution,
        ConnectionRevision,
        ConnectionActivation,
      ],
      migrations: KNOWLEDGE_MIGRATIONS,
    });
    dataSource = new DataSource(executorPg.options);
    await dataSource.initialize();
    await dataSource.runMigrations();

    @Module({
      imports: [
        ConfigModule.forRoot({ load: [configuration], isGlobal: true }),
        TypeOrmModule.forRoot({ ...(executorPg.options as any), migrationsRun: false }),
        TypeOrmModule.forFeature([
          DocumentRecord,
          DocumentChunk,
          KnowledgeNote,
          GenerationExecution,
          ConnectionRevision,
          ConnectionActivation,
        ]),
      ],
      controllers: [InternalGenerationController],
      providers: [
        GenerationService,
        ConnectionTestService,
        ConnectionRevisionsService,
        DocumentChunksService,
        KnowledgeNotesService,
        // Construído à mão porque o parâmetro opcional de `fetch` não é
        // injetável: é a mesma classe do módulo real, e o controller só lhe
        // pergunta as capacidades declaradas.
        { provide: OpenAiChatAdapter, useFactory: () => new OpenAiChatAdapter() },
        { provide: LLM_PROVIDER, useValue: provedorStub() },
        // O cálculo de embedding é o outro modelo externo, e é stubado pelo
        // mesmo motivo do provedor de texto: determinismo, e nenhuma chamada a
        // infraestrutura remota. Tudo o que decide autorização e contrato
        // continua real.
        { provide: OllamaService, useValue: { embed: async () => embedding() } },
      ],
    })
    class ContratoModule {}

    app = await NestFactory.create(ContratoModule, { logger: false, abortOnError: false });
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.listen(0, '127.0.0.1');
    baseUrl = await app.getUrl();

    cliente = createLlmGatewayClient({ baseUrl, token: TOKEN_NORMAN });
    clienteRestrito = createLlmGatewayClient({ baseUrl, token: TOKEN_RESTRITO });

    normanDb.atual = await startEmbeddedPostgres();
    await createAiControlBaseline(normanDb.atual);
    await aplicarMigrationsDoNorman(normanDb.atual.pool);
    controle = servicoDeControle();

    // A revisão nasce reconhecida e a ativação semeada pela migration do Norman
    // é confirmada no executor — pelas rotas reais, com o cliente real.
    await cliente.syncRevision({ connectionKey: 'ollama', revision: 1, model: MODELO_A });
    const vigente = await aiProviderControlRepository.latestActivation();
    await cliente.confirmActivation({
      connectionKey: 'ollama',
      revision: 1,
      activationId: vigente!.id,
    });

    await semearTrecho(CLIENTE, 'A cor institucional da Acme e o azul 1A3E8C.');
    await semearTrecho(OUTRO_CLIENTE, 'A cor institucional da Rival e o verde 0F7A32.', 'rival.pdf');
  }, 180000);

  afterAll(async () => {
    await app?.close();
    if (dataSource?.isInitialized) await dataSource.destroy();
    await executorPg?.stop();
    await normanDb.atual?.stop();
    normanDb.atual = null;
    for (const [chave, valor] of Object.entries(ambienteOriginal)) {
      if (valor === undefined) delete process.env[chave];
      else process.env[chave] = valor;
    }
  });

  beforeEach(() => {
    provedor.respostas = [];
    provedor.pedidos = [];
  });

  /**
   * A verificação que o defeito P0.1 exigia: toda operação que o mapa do Norman
   * pode produzir precisa estar autorizada ao consumidor `norman` do executor.
   * Acrescentar um par genérico lá sem autorizá-lo aqui derruba este caso.
   */
  it('toda operação que o mapa genérico do Norman produz está autorizada ao Norman', () => {
    const produzidas = [...Object.keys(GENERIC_FEATURE), ...Object.values(GENERIC_FEATURE)];

    expect(produzidas.length).toBeGreaterThan(0);
    for (const operacao of produzidas) {
      expect(NORMAN_FEATURES).toContain(operacao);
    }
  });

  it('as capacidades declaradas ao Norman cobrem as operações que ele produz', async () => {
    const capacidades = await cliente.capabilities();

    expect(capacidades.contractVersion).toBe(GATEWAY_CONTRACT_VERSION);
    const declaradas = capacidades.features.map((feature) => feature.feature);
    for (const operacao of Object.values(GENERIC_FEATURE)) {
      expect(declaradas).toContain(operacao);
    }
  });

  it('conversa sem cliente atravessa guard, validação e controller', async () => {
    provedor.respostas = ['Escolha um cliente para eu consultar o acervo dele.'];

    const resposta = await adapter({ clientId: null }).chat([], 'bom dia');

    expect(resposta).toBe('Escolha um cliente para eu consultar o acervo dele.');
    const registradas = await dataSource
      .getRepository(GenerationExecution)
      .find({ where: { correlationId: 'corr-de-contrato' } });
    expect(registradas.map((item) => item.feature)).toEqual(['chat_generic']);
  });

  it('a conversa sem cliente não leva conhecimento de cliente nenhum', async () => {
    provedor.respostas = ['sem acervo aqui'];

    await adapter({ clientId: null }).chat([], 'qual é a cor da marca?');

    expect(provedor.pedidos).toHaveLength(1);
    const enviado = JSON.stringify(provedor.pedidos[0].messages);
    expect(enviado).not.toContain('1A3E8C');
    expect(enviado).not.toContain('0F7A32');
  });

  it('conversa por cliente é autorizada e enxerga só o acervo daquele cliente', async () => {
    provedor.respostas = ['A cor é o azul 1A3E8C.'];

    const resposta = await adapter({
      clientId: CLIENTE,
      retrievalQuestion: 'qual é a cor da marca?',
    } as any).chat([], 'qual é a cor da marca?');

    expect(resposta).toBe('A cor é o azul 1A3E8C.');
    expect(provedor.pedidos).toHaveLength(1);
    const enviado = JSON.stringify(provedor.pedidos[0].messages);
    expect(enviado).toContain('1A3E8C');
    expect(enviado).not.toContain('0F7A32');
  });

  it('o consumidor restrito recebe 403 na operação genérica do Norman', async () => {
    await expect(
      clienteRestrito.complete({
        correlationId: 'corr-de-contrato',
        feature: 'chat_generic',
        actor: { userId: 'usuario-1' },
        activation: { activationId: 'x', connectionKey: 'ollama', connectionRevision: 1 },
        messages: [{ role: 'user', content: 'bom dia' }],
      } as any),
    ).rejects.toThrow(/403/);
  });

  it('o consumidor restrito também não alcança conhecimento por cliente', async () => {
    await expect(
      clienteRestrito.complete({
        correlationId: 'corr-de-contrato',
        feature: 'job_insights',
        actor: { userId: 'usuario-1' },
        activation: { activationId: 'x', connectionKey: 'ollama', connectionRevision: 1 },
        clientId: CLIENTE,
        messages: [{ role: 'user', content: 'bom dia' }],
      } as any),
    ).rejects.toThrow(/403/);
  });

  it('a operação genérica com cliente continua recusada pela validação', async () => {
    await expect(
      cliente.complete({
        correlationId: 'corr-de-contrato',
        feature: 'chat_generic',
        actor: { userId: 'usuario-1' },
        activation: { activationId: 'act', connectionKey: 'ollama', connectionRevision: 1 },
        clientId: CLIENTE,
        messages: [{ role: 'user', content: 'bom dia' }],
      } as any),
    ).rejects.toThrow(/400/);
  });

  it('a operação vinculada sem cliente continua recusada pela validação', async () => {
    await expect(
      cliente.complete({
        correlationId: 'corr-de-contrato',
        feature: 'chat',
        actor: { userId: 'usuario-1' },
        activation: { activationId: 'act', connectionKey: 'ollama', connectionRevision: 1 },
        messages: [{ role: 'user', content: 'bom dia' }],
      } as any),
    ).rejects.toThrow(/400/);
  });

  /**
   * A trava operacional ponta a ponta: o Norman resolve a ativação confirmada
   * real e o executor a aceita contra o próprio registro de ativações.
   */
  it('a trava operacional gera com a ativação confirmada real', async () => {
    provedor.respostas = ['gerado pela conexão travada'];
    const vigente = await aiProviderControlRepository.latestActivation();

    const resposta = await adapter({ clientId: null }, 'ollama').chat([], 'bom dia');

    expect(resposta).toBe('gerado pela conexão travada');
    const snapshot = await servicoDeControle('ollama').activeSnapshot();
    expect(snapshot.activationId).toBe(vigente!.id);
    expect(snapshot.activationId).not.toMatch(/^forced:/);
    expect(snapshot.connectionRevision).toBe(1);
    expect(snapshot.provider.model).toBe('llama-local');
  });

  it('a trava para uma chave sem ativação confirmada falha antes do gateway', async () => {
    provedor.respostas = ['não deveria chegar ao provedor'];

    await expect(adapter({ clientId: null }, 'grok').chat([], 'bom dia')).rejects.toMatchObject({
      code: 'AI_PROVIDER_FORCED_WITHOUT_ACTIVATION',
    });
    expect(provedor.pedidos).toHaveLength(0);
  });

  it('a identidade fabricada que a trava produzia é recusada pelo executor', async () => {
    await expect(
      cliente.complete({
        correlationId: 'corr-de-contrato',
        feature: 'chat_generic',
        actor: { userId: 'usuario-1' },
        activation: {
          activationId: 'forced:ollama',
          connectionKey: 'ollama',
          connectionRevision: 1,
        },
        messages: [{ role: 'user', content: 'bom dia' }],
      } as any),
    ).rejects.toThrow(/400/);
    expect(provedor.pedidos).toHaveLength(0);
  });

  describe('o modelo do pedido vem da ativação confirmada, e não do padrão corrente', () => {
    let padraoOriginal: string | undefined;

    beforeEach(() => {
      padraoOriginal = process.env.OLLAMA_MODEL;
      process.env.OLLAMA_MODEL = MODELO_B;
    });

    afterEach(() => {
      if (padraoOriginal === undefined) delete process.env.OLLAMA_MODEL;
      else process.env.OLLAMA_MODEL = padraoOriginal;
    });

    it('o padrão corrente muda para B sem revisão nova nem ativação nova', async () => {
      const capacidades = await cliente.capabilities();
      const ollama = (capacidades.connections as any[]).find((item) => item.key === 'ollama');

      expect(ollama.defaultModel).toBe(MODELO_B);
      expect(ollama.allowedModels).toEqual(expect.arrayContaining([MODELO_A, MODELO_B]));
      expect(ollama.recognizedRevisions).toHaveLength(1);
      expect(ollama.recognizedRevisions[0]).toMatchObject({ revision: 1, model: MODELO_A });

      const confirmadas = await dataSource.getRepository(ConnectionActivation).find();
      expect(confirmadas).toHaveLength(1);
      expect(confirmadas[0].model).toBe(MODELO_A);
    });

    it('o caminho normal continua enviando o modelo A e o executor aceita', async () => {
      provedor.respostas = ['gerado com o modelo da ativação'];
      const servico = servicoDeControle();
      const vigente = await aiProviderControlRepository.latestActivation();

      const resposta = await adapter({ clientId: null }, undefined, servico).chat([], 'bom dia');

      expect(resposta).toBe('gerado com o modelo da ativação');
      expect(provedor.pedidos).toHaveLength(1);
      expect(provedor.pedidos[0].model).toBe(MODELO_A);

      const snapshot = await servico.activeSnapshot();
      expect(snapshot.activationId).toBe(vigente!.id);
      expect(snapshot.connectionRevision).toBe(1);
      expect(snapshot.provider.model).toBe(MODELO_A);
    });

    it('a trava operacional continua enviando o modelo A e o executor aceita', async () => {
      provedor.respostas = ['gerado pela trava com o modelo da ativação'];
      const servico = servicoDeControle('ollama');
      const vigente = await aiProviderControlRepository.latestActivation();

      const resposta = await adapter({ clientId: null }, 'ollama', servico).chat([], 'bom dia');

      expect(resposta).toBe('gerado pela trava com o modelo da ativação');
      expect(provedor.pedidos).toHaveLength(1);
      expect(provedor.pedidos[0].model).toBe(MODELO_A);

      const snapshot = await servico.activeSnapshot();
      expect(snapshot.activationId).toBe(vigente!.id);
      expect(snapshot.activationId).not.toMatch(/^forced:/);
      expect(snapshot.connectionRevision).toBe(1);
      expect(snapshot.provider.model).toBe(MODELO_A);
    });

    it('a ativação legada migrada recupera o modelo exato, sem aproximar', async () => {
      const vigente = await aiProviderControlRepository.latestActivation();
      const local = await aiProviderControlRepository.findConfirmedActivation(vigente!.id);

      expect(local!.activationId).toBe(vigente!.id);
      expect(local!.model).not.toBe(MODELO_A);
      expect(local!.model).not.toBe(MODELO_B);

      const confirmada = await cliente.describeActivation(vigente!.id);
      expect(confirmada).toMatchObject({ connectionKey: 'ollama', revision: 1, model: MODELO_A });

      provedor.respostas = ['legada gerando'];
      await adapter({ clientId: null }, undefined, servicoDeControle()).chat([], 'bom dia');
      expect(provedor.pedidos[0].model).toBe(MODELO_A);
    });

    it('o recálculo pelo padrão corrente seria recusado pelo executor', async () => {
      const vigente = await aiProviderControlRepository.latestActivation();

      await expect(
        cliente.complete({
          correlationId: 'corr-de-contrato',
          feature: 'chat_generic',
          actor: { userId: 'usuario-1' },
          activation: {
            activationId: vigente!.id,
            connectionKey: 'ollama',
            connectionRevision: 1,
            model: MODELO_B,
          },
          messages: [{ role: 'user', content: 'bom dia' }],
        } as any),
      ).rejects.toThrow(/400/);
      expect(provedor.pedidos).toHaveLength(0);
    });

    it('a mesma ativação com o modelo A continua aceita pela rota real', async () => {
      provedor.respostas = ['aceita com o modelo fixado'];
      const vigente = await aiProviderControlRepository.latestActivation();

      const resposta = await cliente.complete({
        correlationId: 'corr-de-contrato',
        feature: 'chat_generic',
        actor: { userId: 'usuario-1' },
        activation: {
          activationId: vigente!.id,
          connectionKey: 'ollama',
          connectionRevision: 1,
          model: MODELO_A,
        },
        messages: [{ role: 'user', content: 'bom dia' }],
      } as any);

      expect(resposta.text).toBe('aceita com o modelo fixado');
      expect(provedor.pedidos[0].model).toBe(MODELO_A);
    });
  });

  it('contrato desencontrado falha explicitamente, sem cair para a versão antiga', async () => {
    const resposta = await fetch(`${baseUrl}/internal/generation/v1/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-internal-token': TOKEN_NORMAN },
      body: JSON.stringify({
        contractVersion: 1,
        correlationId: 'corr-de-contrato',
        feature: 'chat_generic',
        actor: { userId: 'usuario-1' },
        activation: { activationId: 'act', connectionKey: 'ollama', connectionRevision: 1 },
        messages: [{ role: 'user', content: 'bom dia' }],
      }),
    });

    expect(resposta.status).toBe(400);
    expect(await resposta.text()).toContain('contractVersion');
  });

  it('token inválido não passa do guard', async () => {
    const resposta = await fetch(`${baseUrl}/internal/generation/capabilities`, {
      headers: { 'x-internal-token': 'token-inventado' },
    });

    expect(resposta.status).toBe(401);
  });

  it('nenhuma URL nem credencial de provedor atravessa o contrato', async () => {
    provedor.respostas = ['resposta'];

    const capacidades = JSON.stringify(await cliente.capabilities());
    await adapter({ clientId: null }).chat([], 'bom dia');

    for (const declarado of [capacidades, JSON.stringify(provedor.pedidos)]) {
      expect(declarado).not.toContain('11434');
      expect(declarado).not.toContain('api.x.ai');
      expect(declarado).not.toContain('api.openai.com');
      expect(declarado).not.toContain(TOKEN_NORMAN);
    }
  });
});
