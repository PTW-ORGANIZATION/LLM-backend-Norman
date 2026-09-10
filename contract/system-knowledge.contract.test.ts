import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Module, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { getQueueToken } from '@nestjs/bullmq';
import { TypeOrmModule } from '@nestjs/typeorm';
import type { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { toSql } from 'pgvector';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import configuration from '../src/config/configuration';
import { DocumentChunk } from '../src/documents/document-chunk.entity';
import { DocumentRecord } from '../src/documents/document.entity';
import { DocumentChunksService } from '../src/documents/document-chunks.service';
import { DocumentsService } from '../src/documents/documents.service';
import { KnowledgeRevocation } from '../src/documents/knowledge-revocation.entity';
import { RevocationsService } from '../src/documents/revocations.service';
import { KnowledgeNote } from '../src/knowledge/knowledge-note.entity';
import { KnowledgeNotesService } from '../src/knowledge/knowledge-notes.service';
import { ConnectionActivation } from '../src/gateway/connection-activation.entity';
import { ConnectionRevision } from '../src/gateway/connection-revision.entity';
import { ConnectionRevisionsService } from '../src/gateway/connection-revisions.service';
import { ConnectionTestService } from '../src/gateway/connection-test.service';
import { GenerationExecution } from '../src/gateway/generation-execution.entity';
import { GenerationService } from '../src/gateway/generation.service';
import { InternalGenerationController } from '../src/gateway/internal-generation.controller';
import { InternalDocumentsController } from '../src/ingestion/internal-documents.controller';
import { InternalKnowledgeController } from '../src/ingestion/internal-knowledge.controller';
import { TextExtractionService } from '../src/ingestion/extraction/text-extraction.service';
import { LLM_PROVIDER } from '../src/gateway/llm-provider.token';
import { OpenAiChatAdapter } from '../src/gateway/openai-chat.adapter';
import { OllamaService } from '../src/ollama/ollama.service';
import { INGESTION_JOBS_QUEUE_NAME, KNOWLEDGE_JOBS_QUEUE_NAME } from '../src/queue/queue.constants';
import { startIntegrationPostgres, type EmbeddedPostgres } from '../src/test/embedded-postgres';
import { KNOWLEDGE_MIGRATIONS } from '../src/test/knowledge-migrations';

/**
 * As duas camadas de conhecimento pela rede, com os dois lados de verdade.
 *
 * O que esta suíte prova e nenhuma das duas isoladas provava: que a ingestão do
 * acervo geral do Norman chega ao executor **como acervo geral** — sem cliente,
 * pelo contrato interno real, com guard e DTO reais — e que uma geração
 * vinculada a um cliente enxerga aquela fonte geral **e** o acervo privado
 * daquele cliente, e nada do acervo privado do outro.
 *
 * Real aqui: o servidor HTTP do Nest, o `InternalAuthGuard`, o `ValidationPipe`
 * com os DTOs, os controllers de ingestão e de geração, o `GenerationService`
 * com as duas consultas, o PostgreSQL embarcado com as migrations, e do lado do
 * Norman o `createLlmBackendKnowledgeAdapter`, o `createKnowledgeService` e o
 * `createLlmGatewayClient`.
 *
 * Stubado: só os modelos externos — texto e embedding — e o armazenamento de
 * arquivo do repositório, que não pertence a nenhum dos dois serviços. Nenhuma
 * regra de escopo, autorização ou contrato é reimplementada aqui: foi
 * exatamente essa duplicação num servidor falso que deixou defeito de
 * integração passar verde antes.
 */

const TOKEN = 'token-de-contrato-do-acervo';
const CLIENTE_A = 'contrato-cliente-a';
const CLIENTE_B = 'contrato-cliente-b';
const MODELO = 'llama-local';

const AMBIENTE: Record<string, string> = {
  INTERNAL_API_TOKEN: TOKEN,
  INTERNAL_CONSUMERS: '',
  OLLAMA_MODEL: MODELO,
  OLLAMA_ALLOWED_MODELS: MODELO,
  OPENAI_ALLOWED_MODELS: '',
};

const normanDb: { atual: any } = { atual: null };

vi.mock('@norman/db', () => ({
  get db() {
    return normanDb.atual!.db;
  },
  get pool() {
    return normanDb.atual!.pool;
  },
}));

const { createLlmGatewayClient } = await import('@norman/modules/ai/llm-gateway.client');
const { createGatewayAiAdapter } = await import('@norman/modules/ai/gateway-ai.adapter');
const { createLlmBackendKnowledgeAdapter } = await import(
  '@norman/modules/knowledge/llm-backend-knowledge.adapter'
);
const { createKnowledgeService } = await import('@norman/modules/knowledge/knowledge.service');
const { SYSTEM_KNOWLEDGE_ROOT } = await import('@norman/modules/knowledge/briefing-source-path');
const {
  startEmbeddedPostgres,
  createAiControlBaseline,
  AI_CONTROL_MIGRATIONS,
  KNOWLEDGE_SOURCE_MIGRATIONS,
} = await import('@norman/test/embedded-postgres');
const { aiKnowledgeRepository } = await import(
  '@norman/modules/ai-knowledge/ai-knowledge.repository'
);
const { createAiKnowledgeService } = await import(
  '@norman/modules/ai-knowledge/ai-knowledge.service'
);
const { aiProviderControlRepository } = await import(
  '@norman/modules/ai-provider-control/ai-provider-control.repository'
);
const { createAiProviderControlService } = await import(
  '@norman/modules/ai-provider-control/ai-provider-control.service'
);

const NORMAN_REPO = process.env.NORMAN_REPO_PATH
  ? path.resolve(process.env.NORMAN_REPO_PATH)
  : path.resolve(__dirname, '..', '..', 'Norman');

async function aplicarMigrationsDoNorman(pool: { query: (sql: string) => Promise<unknown> }) {
  for (const arquivo of [...AI_CONTROL_MIGRATIONS, ...KNOWLEDGE_SOURCE_MIGRATIONS]) {
    await pool.query(await readFile(path.join(NORMAN_REPO, 'migrations', arquivo), 'utf8'));
  }
}

function embedding(): number[] {
  return Array.from({ length: 768 }, (_, index) => (index % 7) / 10);
}

const provedor = {
  pedidos: [] as Array<{ messages: Array<{ role: string; content: string }> }>,
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
      provedor.pedidos.push({ messages: request.messages });
      return { text: 'resposta do provedor', promptTokens: 10, completionTokens: 3 };
    },
    async *generateStream(_connection: any, request: any) {
      provedor.pedidos.push({ messages: request.messages });
      yield { kind: 'delta' as const, text: 'resposta do provedor' };
      yield { kind: 'completed' as const, promptTokens: 10, completionTokens: 3 };
    },
  };
}

/** A fila, stubada: o que importa aqui é o registro, não o worker. */
function filaStub() {
  const jobs: Array<{ name: string; data: any }> = [];
  return {
    jobs,
    queue: {
      add: async (name: string, data: unknown) => {
        jobs.push({ name, data });
        return { id: 'job-1' };
      },
      remove: async () => 1,
      getJob: async () => undefined,
    },
  };
}

describe('contrato das duas camadas de conhecimento, pela rede', () => {
  let executorPg: EmbeddedPostgres;
  let dataSource: DataSource;
  let app: INestApplication;
  let baseUrl: string;
  let ambienteOriginal: Record<string, string | undefined>;
  let gateway: ReturnType<typeof createLlmGatewayClient>;
  let conhecimento: ReturnType<typeof createKnowledgeService>;
  let controle: ReturnType<typeof createAiProviderControlService>;
  const ingestao = filaStub();
  const estudo = filaStub();

  function adapter(escopo: Record<string, unknown>) {
    return createGatewayAiAdapter({
      client: gateway,
      legacy: {} as any,
      resolveActivation: async () => {
        const snapshot = await controle.activeSnapshot();
        return {
          activationId: snapshot.activationId,
          connectionKey: snapshot.connectionKey,
          connectionRevision: snapshot.connectionRevision,
          model: snapshot.provider.model,
        };
      },
      resolveContext: () => ({
        correlationId: 'corr-das-camadas',
        actor: { userId: 'usuario-1' },
        scope: escopo as any,
      }),
    });
  }

  /**
   * Vetoriza o que a ingestão vetorizaria, para o documento já registrado.
   *
   * O worker de ingestão não roda aqui — ele exige Redis. O que interessa é
   * que o documento chegou ao executor **no nível certo**, e os chunks são
   * gravados com o mesmo nível que o registro deixou na linha.
   */
  async function vetorizar(storagePath: string, conteudo: string) {
    const [linha] = await dataSource.query(
      `SELECT id, knowledge_scope, client_id, scope_path FROM documents WHERE storage_path = $1`,
      [storagePath],
    );
    expect(linha).toBeTruthy();
    await dataSource.query(
      `INSERT INTO document_chunks
         (document_id, knowledge_scope, client_id, scope_path, chunk_index, page_number, content,
          embedding, embedding_model, embedding_dimensions)
       VALUES ($1, $2, $3, $4, 0, 1, $5, $6::vector, 'nomic-embed-text', 768)`,
      [
        linha.id,
        linha.knowledge_scope,
        linha.client_id,
        linha.scope_path,
        conteudo,
        toSql(embedding()),
      ],
    );
    return linha;
  }

  function contextoDe(indice = 0): string {
    return provedor.pedidos[indice].messages
      .filter((mensagem) => mensagem.role === 'system')
      .map((mensagem) => mensagem.content)
      .join('\n');
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
        KnowledgeRevocation,
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
          KnowledgeRevocation,
          GenerationExecution,
          ConnectionRevision,
          ConnectionActivation,
        ]),
      ],
      controllers: [
        InternalGenerationController,
        InternalDocumentsController,
        InternalKnowledgeController,
      ],
      providers: [
        GenerationService,
        ConnectionTestService,
        ConnectionRevisionsService,
        DocumentChunksService,
        DocumentsService,
        RevocationsService,
        KnowledgeNotesService,
        { provide: OpenAiChatAdapter, useFactory: () => new OpenAiChatAdapter() },
        { provide: LLM_PROVIDER, useValue: provedorStub() },
        { provide: OllamaService, useValue: { embed: async () => embedding() } },
        // A extração de texto não é o objeto desta prova: o que atravessa a
        // fronteira aqui é o nível do acervo, não o parser de arquivo.
        {
          provide: TextExtractionService,
          useValue: { extract: async () => ({ pages: [{ pageNumber: 1, text: 'texto' }], source: 'plain' }) },
        },
        { provide: getQueueToken(INGESTION_JOBS_QUEUE_NAME), useValue: ingestao.queue },
        { provide: getQueueToken(KNOWLEDGE_JOBS_QUEUE_NAME), useValue: estudo.queue },
      ],
    })
    class CamadasModule {}

    app = await NestFactory.create(CamadasModule, { logger: false, abortOnError: false });
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.listen(0, '127.0.0.1');
    baseUrl = await app.getUrl();

    gateway = createLlmGatewayClient({ baseUrl, token: TOKEN });

    // O serviço de conhecimento do Norman, falando com o executor pelas rotas
    // internas reais. O armazenamento de arquivo é o único ponto stubado: ele
    // é do repositório do Norman, e não da fronteira que esta suíte prova.
    conhecimento = createKnowledgeService({
      knowledge: createLlmBackendKnowledgeAdapter({ baseUrl, token: TOKEN }),
      listClients: async () => [
        { id: CLIENTE_A, name: 'Cliente A', assetFolderName: 'ClienteA' },
        { id: CLIENTE_B, name: 'Cliente B', assetFolderName: 'ClienteB' },
      ],
      stageRepositoryUpload: async () => ({
        id: 'arquivo-1',
        publicationGeneration: 1,
        publicationState: 'storage_confirmed',
      }),
    });

    normanDb.atual = await startEmbeddedPostgres();
    await createAiControlBaseline(normanDb.atual);
    await aplicarMigrationsDoNorman(normanDb.atual.pool);
    controle = createAiProviderControlService(aiProviderControlRepository, {}, {
      describeConnectionsAtExecutor: async () => (await gateway.capabilities()).connections as any,
      syncRevisionAtExecutor: gateway.syncRevision,
      confirmActivationAtExecutor: gateway.confirmActivation,
      describeActivationAtExecutor: gateway.describeActivation,
    } as any);

    await gateway.syncRevision({ connectionKey: 'ollama', revision: 1, model: MODELO });
    const vigente = await aiProviderControlRepository.latestActivation();
    await gateway.confirmActivation({
      connectionKey: 'ollama',
      revision: 1,
      activationId: vigente!.id,
    });

    // A ingestão do acervo geral, pela porta explícita do Norman: ela declara o
    // nível e não manda cliente nenhum.
    await conhecimento.rememberSystemKnowledgeFile({
      repositoryPath: `${SYSTEM_KNOWLEDGE_ROOT}/tom-de-voz.pdf`,
      fileName: 'tom-de-voz.pdf',
      sha256: 'a'.repeat(64),
      mimeType: 'application/pdf',
      sizeBytes: 2048,
    });
    await vetorizar(
      `${SYSTEM_KNOWLEDGE_ROOT}/tom-de-voz.pdf`,
      'O tom de voz do Norman e direto e sem jargao.',
    );

    // E a ingestão do acervo de cada cliente, pela varredura do repositório.
    for (const [hash, pasta, conteudo] of [
      ['b'.repeat(64), 'ClienteA', 'A cor institucional do Cliente A e azul-cobalto.'],
      ['c'.repeat(64), 'ClienteB', 'A cor institucional do Cliente B e verde-musgo.'],
    ] as Array<[string, string, string]>) {
      await conhecimento.rememberRepositoryFile({
        repositoryPath: `${pasta}/01_Brand/marca.pdf`,
        fileName: 'marca.pdf',
        sha256: hash,
        mimeType: 'application/pdf',
        sizeBytes: 1024,
      });
      await vetorizar(`${pasta}/01_Brand/marca.pdf`, conteudo);
    }
  }, 240000);

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
    provedor.pedidos = [];
  });

  it('a ingestão geral chega ao executor sem cliente e no nível geral', async () => {
    const [linha] = await dataSource.query(
      `SELECT knowledge_scope, client_id FROM documents WHERE storage_path = $1`,
      [`${SYSTEM_KNOWLEDGE_ROOT}/tom-de-voz.pdf`],
    );

    expect(linha).toEqual({ knowledge_scope: 'system', client_id: null });
  });

  it('a ingestão de cliente continua chegando com o cliente dono', async () => {
    const linhas = await dataSource.query(
      `SELECT knowledge_scope, client_id FROM documents
        WHERE knowledge_scope = 'client' ORDER BY client_id`,
    );

    expect(linhas).toEqual([
      { knowledge_scope: 'client', client_id: CLIENTE_A },
      { knowledge_scope: 'client', client_id: CLIENTE_B },
    ]);
  });

  // O caso de aceite do plano: a mesma fonte geral compõe a geração dos dois
  // clientes, e o acervo privado de cada um continua só dele.
  it('a fonte geral compõe a geração dos dois clientes, e o privado não vaza', async () => {
    const paraA = adapter({
      clientId: CLIENTE_A,
      retrievalQuestion: 'qual e o tom e a cor?',
    });
    await paraA.chat([], 'qual e o tom e a cor?');
    const contextoA = contextoDe(0);

    const paraB = adapter({
      clientId: CLIENTE_B,
      retrievalQuestion: 'qual e o tom e a cor?',
    });
    await paraB.chat([], 'qual e o tom e a cor?');
    const contextoB = contextoDe(1);

    expect(contextoA).toContain('[sistema | tom-de-voz.pdf');
    expect(contextoB).toContain('[sistema | tom-de-voz.pdf');
    expect(contextoA).toContain('azul-cobalto');
    expect(contextoB).toContain('verde-musgo');
    expect(contextoA).not.toContain('verde-musgo');
    expect(contextoB).not.toContain('azul-cobalto');
  });

  it('a citação distingue a camada de cada trecho', async () => {
    const citacoes: unknown[] = [];
    const comCitacao = createGatewayAiAdapter({
      client: gateway,
      legacy: {} as any,
      resolveActivation: async () => {
        const snapshot = await controle.activeSnapshot();
        return {
          activationId: snapshot.activationId,
          connectionKey: snapshot.connectionKey,
          connectionRevision: snapshot.connectionRevision,
          model: snapshot.provider.model,
        };
      },
      resolveContext: () => ({
        correlationId: 'corr-das-camadas',
        actor: { userId: 'usuario-1' },
        scope: { clientId: CLIENTE_A, retrievalQuestion: 'qual e o tom e a cor?' } as any,
      }),
      onOutcome: (outcome) => { citacoes.push(...outcome.citations); },
    });

    await comCitacao.chat([], 'qual e o tom e a cor?');

    const camadas = (citacoes as Array<{ scope?: string }>).map((citacao) => citacao.scope).sort();
    expect(camadas).toEqual(['client', 'system']);
  });

  it('a operação genérica não recebe camada nenhuma', async () => {
    const generico = adapter({});

    await generico.chat([], 'qual e o tom?');

    const contexto = contextoDe(0);
    expect(contexto).not.toContain('tom de voz do Norman');
    expect(contexto).not.toContain('azul-cobalto');
  });

  // A garantia já auditada continua: escopo de acervo sem cliente é pedido
  // malformado, e atendê-lo pela metade esconderia o defeito de transporte.
  it('escopo de acervo sem cliente continua sendo recusado', async () => {
    const malformado = adapter({ retrievalQuestion: 'qual e o tom?' });

    await expect(malformado.chat([], 'qual e o tom?')).rejects.toThrow(
      /escopo de acervo foi informado sem cliente/,
    );
  });

  it('retenção da camada geral tira só ela, e a resposta diz isso', async () => {
    const retido = adapter({
      clientId: CLIENTE_A,
      retrievalQuestion: 'qual e o tom e a cor?',
      systemKnowledgeUnavailable: true,
    });

    await retido.chat([], 'qual e o tom e a cor?');

    const contexto = contextoDe(0);
    expect(contexto).not.toContain('tom de voz do Norman');
    expect(contexto).toContain('azul-cobalto');
    expect(contexto).toContain('camada de conhecimento geral do Norman não pôde ser consultada');
  });

  // A revogação geral confirmada faz a fonte parar de aparecer para todos os
  // clientes na mesma chamada, e não deixa o acervo privado de ninguém para
  // trás.
  it('a revogação geral confirmada apaga a evidência dos dois clientes', async () => {
    const removida = await conhecimento.forgetSystemKnowledgeFile(
      `${SYSTEM_KNOWLEDGE_ROOT}/tom-de-voz.pdf`,
    );
    expect(removida).toEqual({ forgotten: true });

    const paraA = adapter({ clientId: CLIENTE_A, retrievalQuestion: 'qual e o tom e a cor?' });
    await paraA.chat([], 'qual e o tom e a cor?');
    const paraB = adapter({ clientId: CLIENTE_B, retrievalQuestion: 'qual e o tom e a cor?' });
    await paraB.chat([], 'qual e o tom e a cor?');

    expect(contextoDe(0)).not.toContain('tom de voz do Norman');
    expect(contextoDe(1)).not.toContain('tom de voz do Norman');
    expect(contextoDe(0)).toContain('azul-cobalto');
    expect(contextoDe(1)).toContain('verde-musgo');
  });

  it('o caminho geral revogado não volta pela ingestão seguinte', async () => {
    const resposta = await conhecimento.rememberSystemKnowledgeFile({
      repositoryPath: `${SYSTEM_KNOWLEDGE_ROOT}/tom-de-voz.pdf`,
      fileName: 'tom-de-voz.pdf',
      sha256: 'a'.repeat(64),
      mimeType: 'application/pdf',
      sizeBytes: 2048,
    });

    expect(resposta).toEqual({ ingested: false, revoked: true });
    const linhas = await dataSource.query(
      `SELECT 1 FROM documents WHERE storage_path = $1`,
      [`${SYSTEM_KNOWLEDGE_ROOT}/tom-de-voz.pdf`],
    );
    expect(linhas).toEqual([]);
  });
  describe('anúncio durável da fonte geral, pela rede', () => {
    const CAMINHO_GERAL = `${SYSTEM_KNOWLEDGE_ROOT}/politica-de-marca.md`;
    let acervoAlcancavel = true;
    let acervo: ReturnType<typeof createAiKnowledgeService>;

    beforeAll(() => {
      acervo = createAiKnowledgeService({
        repository: aiKnowledgeRepository,
        listClients: async () => [
          { id: CLIENTE_A, name: 'Cliente A', assetFolderName: 'ClienteA' },
          { id: CLIENTE_B, name: 'Cliente B', assetFolderName: 'ClienteB' },
        ],
        transcribeAudio: async () => 'transcrição',
        transcription: { provider: 'Groq', model: 'whisper-large-v3-turbo' },
        storeSystemKnowledgeFile: async ({ fileName }) => ({
          stored: true as const,
          clientId: '',
          parentPath: SYSTEM_KNOWLEDGE_ROOT,
          repositoryPath: `${SYSTEM_KNOWLEDGE_ROOT}/${fileName}`,
          publication: { generation: 1, confirmed: true },
        }),
        registerSystemDocument: async (pedido) => {
          if (!acervoAlcancavel) throw new Error('conexão recusada pelo acervo');
          return conhecimento.rememberSystemKnowledgeFile(pedido);
        },
        forgetSystemRepositoryFile: (caminho) => conhecimento.forgetSystemKnowledgeFile(caminho),
        schedule: () => undefined,
      });
    });

    it('o acervo fora do ar não devolve sucesso e deixa o estado persistido', async () => {
      acervoAlcancavel = false;

      const envio = await acervo.addSystemDocumentSource({
        fileName: 'politica-de-marca.md',
        mimeType: 'text/markdown',
        buffer: Buffer.from('A politica de marca do Norman exige contraste alto.'),
      });

      expect(envio.announced).toBe(false);
      expect(envio.source.announceState).toBe('failed');

      const linhas = await dataSource.query(
        `SELECT 1 FROM documents WHERE storage_path = $1`,
        [CAMINHO_GERAL],
      );
      expect(linhas).toEqual([]);
    });

    it('a fonte não registrada não compõe a geração de cliente nenhum', async () => {
      const paraA = adapter({ clientId: CLIENTE_A, retrievalQuestion: 'qual e a politica?' });
      await paraA.chat([], 'qual e a politica?');

      expect(contextoDe(0)).not.toContain('contraste alto');
    });

    it('a retomada depois do reinício registra a fonte pelo contrato interno', async () => {
      acervoAlcancavel = true;
      const depoisDoReinicio = createAiKnowledgeService({
        repository: aiKnowledgeRepository,
        listClients: async () => [],
        transcribeAudio: async () => '',
        transcription: { provider: 'Groq', model: 'whisper-large-v3-turbo' },
        registerSystemDocument: (pedido) => conhecimento.rememberSystemKnowledgeFile(pedido),
        now: () => Date.now() + 60_000,
        workerId: 'replica-depois-do-reinicio',
      });

      await expect(depoisDoReinicio.resumePendingAnnouncements()).resolves.toMatchObject({
        attempted: 1,
        confirmed: 1,
        failed: 0,
      });

      const [linha] = await dataSource.query(
        `SELECT knowledge_scope, client_id FROM documents WHERE storage_path = $1`,
        [CAMINHO_GERAL],
      );
      expect(linha).toEqual({ knowledge_scope: 'system', client_id: null });

      const [fonte] = await acervo.listSystemSources();
      expect(fonte.announceState).toBe('confirmed');
    });

    it('depois de confirmada, a fonte geral compõe a geração dos dois clientes', async () => {
      await vetorizar(CAMINHO_GERAL, 'A politica de marca do Norman exige contraste alto.');

      const paraA = adapter({ clientId: CLIENTE_A, retrievalQuestion: 'qual e a politica?' });
      await paraA.chat([], 'qual e a politica?');
      const paraB = adapter({ clientId: CLIENTE_B, retrievalQuestion: 'qual e a politica?' });
      await paraB.chat([], 'qual e a politica?');

      expect(contextoDe(0)).toContain('contraste alto');
      expect(contextoDe(1)).toContain('contraste alto');
      expect(contextoDe(0)).toContain('azul-cobalto');
      expect(contextoDe(1)).toContain('verde-musgo');
      expect(contextoDe(0)).not.toContain('verde-musgo');
    });

    it('a retomada não tem mais o que fazer depois da confirmação', async () => {
      await expect(acervo.resumePendingAnnouncements()).resolves.toMatchObject({ attempted: 0 });
    });
  });

  describe('reenvio deliberado da fonte geral depois da remoção', () => {
    const NOME = 'politica-de-reenvio.md';
    const CAMINHO = `${SYSTEM_KNOWLEDGE_ROOT}/${NOME}`;
    const PRIMEIRA = 'A primeira politica do Norman pede margem estreita.';
    const SEGUNDA = 'A segunda politica do Norman pede margem larga.';
    let acervo: ReturnType<typeof createAiKnowledgeService>;
    let primeiraFonte = '';

    beforeAll(() => {
      acervo = createAiKnowledgeService({
        repository: aiKnowledgeRepository,
        listClients: async () => [
          { id: CLIENTE_A, name: 'Cliente A', assetFolderName: 'ClienteA' },
          { id: CLIENTE_B, name: 'Cliente B', assetFolderName: 'ClienteB' },
        ],
        transcribeAudio: async () => 'transcrição',
        transcription: { provider: 'Groq', model: 'whisper-large-v3-turbo' },
        storeSystemKnowledgeFile: (entrada) => conhecimento.storeSystemKnowledgeFile(entrada),
        registerSystemDocument: (pedido) => conhecimento.rememberSystemKnowledgeFile(pedido),
        forgetSystemRepositoryFile: (caminho) => conhecimento.forgetSystemKnowledgeFile(caminho),
        schedule: () => undefined,
      });
    });

    it('a primeira versão entra no acervo e compõe a geração dos dois clientes', async () => {
      const envio = await acervo.addSystemDocumentSource({
        fileName: NOME,
        mimeType: 'text/markdown',
        buffer: Buffer.from(PRIMEIRA),
      });
      primeiraFonte = envio.source.id;

      expect(envio.announceState).toBe('confirmed');
      await vetorizar(CAMINHO, PRIMEIRA);

      const paraA = adapter({ clientId: CLIENTE_A, retrievalQuestion: 'qual e a margem?' });
      await paraA.chat([], 'qual e a margem?');
      const paraB = adapter({ clientId: CLIENTE_B, retrievalQuestion: 'qual e a margem?' });
      await paraB.chat([], 'qual e a margem?');

      expect(contextoDe(0)).toContain('margem estreita');
      expect(contextoDe(1)).toContain('margem estreita');
    });

    it('a remoção grava a lápide e tira o conteúdo dos dois clientes', async () => {
      await acervo.removeSystemSource(primeiraFonte);

      const paraA = adapter({ clientId: CLIENTE_A, retrievalQuestion: 'qual e a margem?' });
      await paraA.chat([], 'qual e a margem?');

      expect(contextoDe(0)).not.toContain('margem estreita');
      const [lapide] = await dataSource.query(
        `SELECT knowledge_scope FROM knowledge_revocations WHERE path = $1`,
        [CAMINHO],
      );
      expect(lapide).toEqual({ knowledge_scope: 'system' });
    });

    it('a sincronização comum depois da remoção continua respeitando a lápide', async () => {
      const resposta = await conhecimento.rememberSystemKnowledgeFile({
        repositoryPath: CAMINHO,
        fileName: NOME,
        sha256: 'd'.repeat(64),
        mimeType: 'text/markdown',
        sizeBytes: 10,
      });

      expect(resposta).toEqual({ ingested: false, revoked: true });
      const linhas = await dataSource.query(`SELECT 1 FROM documents WHERE storage_path = $1`, [
        CAMINHO,
      ]);
      expect(linhas).toEqual([]);
    });

    it('o reenvio deliberado no mesmo caminho levanta a lápide e volta a ingerir', async () => {
      const envio = await acervo.addSystemDocumentSource({
        fileName: NOME,
        mimeType: 'text/markdown',
        buffer: Buffer.from(SEGUNDA),
      });

      expect(envio.source.id).not.toBe(primeiraFonte);
      expect(envio.announceState).toBe('confirmed');

      const [linha] = await dataSource.query(
        `SELECT knowledge_scope, client_id FROM documents WHERE storage_path = $1`,
        [CAMINHO],
      );
      expect(linha).toEqual({ knowledge_scope: 'system', client_id: null });

      const lapides = await dataSource.query(
        `SELECT 1 FROM knowledge_revocations WHERE path = $1`,
        [CAMINHO],
      );
      expect(lapides).toEqual([]);
    });

    it('o conteúdo reenviado vale para os dois clientes e o removido não volta', async () => {
      await vetorizar(CAMINHO, SEGUNDA);

      const paraA = adapter({ clientId: CLIENTE_A, retrievalQuestion: 'qual e a margem?' });
      await paraA.chat([], 'qual e a margem?');
      const paraB = adapter({ clientId: CLIENTE_B, retrievalQuestion: 'qual e a margem?' });
      await paraB.chat([], 'qual e a margem?');

      expect(contextoDe(0)).toContain('margem larga');
      expect(contextoDe(1)).toContain('margem larga');
      expect(contextoDe(0)).not.toContain('margem estreita');
      expect(contextoDe(1)).not.toContain('margem estreita');
    });

    it('apenas uma fonte geral vigente ocupa o caminho depois do ciclo', async () => {
      const vigentes = (await acervo.listSystemSources()).filter(
        (fonte: any) => fonte.isCurrent && fonte.assetPath === CAMINHO,
      );

      expect(vigentes).toHaveLength(1);
    });
  });

  describe('reenvio administrativo de documento de cliente', () => {
    const NOME = 'manual-de-reenvio.md';
    const CAMINHO = `ClienteA/Conhecimentos gerais do cliente/${NOME}`;
    const PRIMEIRA = 'O manual do Cliente A pedia papel fosco.';
    const SEGUNDA = 'O manual do Cliente A agora pede papel brilhante.';
    let acervo: ReturnType<typeof createAiKnowledgeService>;
    let primeiraFonte = '';

    beforeAll(() => {
      acervo = createAiKnowledgeService({
        repository: aiKnowledgeRepository,
        listClients: async () => [
          { id: CLIENTE_A, name: 'Cliente A', assetFolderName: 'ClienteA' },
          { id: CLIENTE_B, name: 'Cliente B', assetFolderName: 'ClienteB' },
        ],
        transcribeAudio: async () => 'transcrição',
        transcription: { provider: 'Groq', model: 'whisper-large-v3-turbo' },
        storeGeneralKnowledgeFile: (entrada) => conhecimento.storeGeneralKnowledgeFile(entrada),
        registerClientDocument: (pedido) => conhecimento.rememberAdministrativeClientFile(pedido),
        forgetRepositoryFile: (caminho) => conhecimento.forgetRepositoryFile(caminho),
        schedule: () => undefined,
      });
    });

    it('o documento administrativo entra no acervo daquele cliente e só dele', async () => {
      const envio = await acervo.addDocumentSource({
        clientId: CLIENTE_A,
        fileName: NOME,
        mimeType: 'text/markdown',
        buffer: Buffer.from(PRIMEIRA),
      });
      primeiraFonte = envio.source.id;

      expect(envio.source.status).toBe('studying');
      const [linha] = await dataSource.query(
        `SELECT knowledge_scope, client_id FROM documents WHERE storage_path = $1`,
        [CAMINHO],
      );
      expect(linha).toEqual({ knowledge_scope: 'client', client_id: CLIENTE_A });

      await vetorizar(CAMINHO, PRIMEIRA);
      const paraA = adapter({ clientId: CLIENTE_A, retrievalQuestion: 'qual e o papel?' });
      await paraA.chat([], 'qual e o papel?');
      const paraB = adapter({ clientId: CLIENTE_B, retrievalQuestion: 'qual e o papel?' });
      await paraB.chat([], 'qual e o papel?');

      expect(contextoDe(0)).toContain('papel fosco');
      expect(contextoDe(1)).not.toContain('papel fosco');
    });

    it('a remoção grava a lápide do cliente e a varredura comum a respeita', async () => {
      await acervo.removeSource(primeiraFonte, CLIENTE_A);

      const resposta = await conhecimento.rememberRepositoryFile({
        repositoryPath: CAMINHO,
        fileName: NOME,
        sha256: 'e'.repeat(64),
        mimeType: 'text/markdown',
        sizeBytes: 10,
      });

      expect(resposta).toMatchObject({ ingested: false, reason: 'revoked' });
      const linhas = await dataSource.query(`SELECT 1 FROM documents WHERE storage_path = $1`, [
        CAMINHO,
      ]);
      expect(linhas).toEqual([]);
    });

    it('o reenvio deliberado do cliente volta a ingerir sem quebrar o isolamento', async () => {
      const envio = await acervo.addDocumentSource({
        clientId: CLIENTE_A,
        fileName: NOME,
        mimeType: 'text/markdown',
        buffer: Buffer.from(SEGUNDA),
      });

      expect(envio.source.id).not.toBe(primeiraFonte);
      expect(envio.source.status).toBe('studying');

      const [linha] = await dataSource.query(
        `SELECT knowledge_scope, client_id FROM documents WHERE storage_path = $1`,
        [CAMINHO],
      );
      expect(linha).toEqual({ knowledge_scope: 'client', client_id: CLIENTE_A });

      await vetorizar(CAMINHO, SEGUNDA);
      const paraA = adapter({ clientId: CLIENTE_A, retrievalQuestion: 'qual e o papel?' });
      await paraA.chat([], 'qual e o papel?');
      const paraB = adapter({ clientId: CLIENTE_B, retrievalQuestion: 'qual e o papel?' });
      await paraB.chat([], 'qual e o papel?');

      expect(contextoDe(0)).toContain('papel brilhante');
      expect(contextoDe(0)).not.toContain('papel fosco');
      expect(contextoDe(1)).not.toContain('papel brilhante');
      expect(contextoDe(1)).toContain('verde-musgo');
    });

    it('a lápide do caminho some e apenas uma fonte vigente o ocupa', async () => {
      const lapides = await dataSource.query(
        `SELECT 1 FROM knowledge_revocations WHERE path = $1`,
        [CAMINHO],
      );
      expect(lapides).toEqual([]);

      const vigentes = (await acervo.listSources(CLIENTE_A)).filter(
        (fonte: any) => fonte.isCurrent && fonte.assetPath === CAMINHO,
      );
      expect(vigentes).toHaveLength(1);
      await expect(acervo.isRevokedAssetPath(CAMINHO)).resolves.toBe(false);
    });
  });
});
