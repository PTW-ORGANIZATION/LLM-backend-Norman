import { Module, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { getQueueToken } from '@nestjs/bullmq';
import { TypeOrmModule } from '@nestjs/typeorm';
import type { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
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

const TOKEN_NORMAN = 'token-interno-do-norman';
const TOKEN_NIPROFE = 'token-interno-do-niprofe';
const CLIENTE = 'autorizacao-cliente-a';
const SYSTEM_ROOT = '_Conhecimento geral do sistema';
const MODELO = 'llama-local';

const AMBIENTE: Record<string, string> = {
  INTERNAL_API_TOKEN: TOKEN_NORMAN,
  INTERNAL_CONSUMERS: 'niprofe:NIPROFE_TOKEN:chat:person',
  NIPROFE_TOKEN: TOKEN_NIPROFE,
  OLLAMA_MODEL: MODELO,
  OLLAMA_ALLOWED_MODELS: MODELO,
  OPENAI_ALLOWED_MODELS: '',
};

const { createLlmBackendKnowledgeAdapter } = await import(
  '@norman/modules/knowledge/llm-backend-knowledge.adapter'
);

function embedding(): number[] {
  return Array.from({ length: 768 }, (_, index) => (index % 5) / 10);
}

function espioes(dataSource: () => DataSource) {
  const ingestionQueue = {
    add: vi.fn(async () => ({ id: 'job-1' })),
    remove: vi.fn(async () => 1),
    getJob: vi.fn(async () => undefined),
  };
  const knowledgeQueue = {
    add: vi.fn(async () => ({ id: 'job-2' })),
    remove: vi.fn(async () => 1),
    getJob: vi.fn(async () => undefined),
  };
  const embed = vi.fn(async () => embedding());
  const extract = vi.fn(async () => ({
    pages: [{ pageNumber: 1, text: 'texto extraído' }],
    source: 'plain' as const,
  }));

  function reset() {
    for (const espiao of [
      ingestionQueue.add,
      ingestionQueue.remove,
      ingestionQueue.getJob,
      knowledgeQueue.add,
      knowledgeQueue.remove,
      knowledgeQueue.getJob,
      embed,
      extract,
    ]) {
      espiao.mockClear();
    }
  }

  function nadaFoiTocado() {
    return {
      fila: ingestionQueue.add.mock.calls.length
        + ingestionQueue.remove.mock.calls.length
        + knowledgeQueue.add.mock.calls.length
        + knowledgeQueue.remove.mock.calls.length
        + knowledgeQueue.getJob.mock.calls.length,
      embedding: embed.mock.calls.length,
      extracao: extract.mock.calls.length,
    };
  }

  return { ingestionQueue, knowledgeQueue, embed, extract, reset, nadaFoiTocado, dataSource };
}

describe('autorização das rotas internas por consumidor, pela rede', () => {
  let embedded: EmbeddedPostgres;
  let dataSource: DataSource;
  let app: INestApplication;
  let baseUrl: string;
  let ambienteOriginal: Record<string, string | undefined>;
  let observados: ReturnType<typeof espioes>;
  let consultasAoBanco: string[];

  async function chamar(
    caminho: string,
    token: string,
    corpo: Record<string, unknown> | null = {},
    metodo = 'POST',
  ) {
    const response = await fetch(`${baseUrl}${caminho}`, {
      method: metodo,
      headers: {
        'x-internal-token': token,
        ...(corpo === null ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(corpo === null ? {} : { body: JSON.stringify(corpo) }),
    });
    return { status: response.status, corpo: await response.json().catch(() => null) };
  }

  beforeAll(async () => {
    ambienteOriginal = {};
    for (const [chave, valor] of Object.entries(AMBIENTE)) {
      ambienteOriginal[chave] = process.env[chave];
      process.env[chave] = valor;
    }

    embedded = await startIntegrationPostgres({
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
    dataSource = new DataSource(embedded.options);
    await dataSource.initialize();
    await dataSource.runMigrations();

    observados = espioes(() => dataSource);
    consultasAoBanco = [];

    @Module({
      imports: [
        ConfigModule.forRoot({ load: [configuration], isGlobal: true }),
        TypeOrmModule.forRoot({
          ...(embedded.options as any),
          migrationsRun: false,
          logging: ['query'],
          logger: {
            logQuery: (query: string) => {
              if (/^\s*(insert|update|delete|select)/i.test(query)) consultasAoBanco.push(query);
            },
            logQueryError: () => undefined,
            logQuerySlow: () => undefined,
            logSchemaBuild: () => undefined,
            logMigration: () => undefined,
            log: () => undefined,
          },
        }),
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
        {
          provide: LLM_PROVIDER,
          useValue: {
            protocol: 'openai_chat',
            capabilities: () => ({
              streaming: true,
              structuredOutput: true,
              vision: false,
              cancellation: true,
            }),
            generate: async () => ({ text: 'ok', promptTokens: 1, completionTokens: 1 }),
            generateStream: async function* vazio() {
              yield { kind: 'completed' as const, promptTokens: 0, completionTokens: 0 };
            },
          },
        },
        { provide: OllamaService, useValue: { embed: observados.embed } },
        { provide: TextExtractionService, useValue: { extract: observados.extract } },
        { provide: getQueueToken(INGESTION_JOBS_QUEUE_NAME), useValue: observados.ingestionQueue },
        { provide: getQueueToken(KNOWLEDGE_JOBS_QUEUE_NAME), useValue: observados.knowledgeQueue },
      ],
    })
    class AutorizacaoModule {}

    app = await NestFactory.create(AutorizacaoModule, { logger: false, abortOnError: false });
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.listen(0, '127.0.0.1');
    baseUrl = await app.getUrl();
  }, 240000);

  afterAll(async () => {
    await app?.close();
    if (dataSource?.isInitialized) await dataSource.destroy();
    await embedded?.stop();
    for (const [chave, valor] of Object.entries(ambienteOriginal)) {
      if (valor === undefined) delete process.env[chave];
      else process.env[chave] = valor;
    }
  });

  beforeEach(() => {
    observados.reset();
    consultasAoBanco = [];
  });

  describe('o token do Norman executa o que os adapters dele produzem', () => {
    const conhecimento = () => createLlmBackendKnowledgeAdapter({
      baseUrl,
      token: TOKEN_NORMAN,
    });

    it('registra, renomeia, esquece e reprocessa no acervo de cliente', async () => {
      const adapter = conhecimento();
      const scopePath = `${CLIENTE}/01_Brand`;

      await expect(adapter.registerDocument({
        scope: 'client',
        clientId: CLIENTE,
        scopePath,
        storagePath: `${scopePath}/marca.pdf`,
        filename: 'marca.pdf',
        sha256: 'a'.repeat(64),
        mimeType: 'application/pdf',
        sizeBytes: 1024,
      } as any)).resolves.toMatchObject({ queued: true });

      await expect(adapter.reprocessDocument({
        scope: 'client',
        clientId: CLIENTE,
        storagePath: `${scopePath}/marca.pdf`,
      } as any)).resolves.toEqual({ queued: true });

      await expect(adapter.renamePrefix({
        scope: 'client',
        clientId: CLIENTE,
        fromPath: scopePath,
        toPath: `${CLIENTE}/01_Marca`,
      } as any)).resolves.toBeDefined();

      await expect(adapter.forgetPath({
        scope: 'client',
        clientId: CLIENTE,
        storagePath: `${CLIENTE}/01_Marca/marca.pdf`,
      } as any)).resolves.toBeDefined();

      await expect(adapter.forgetPrefix({
        scope: 'client',
        clientId: CLIENTE,
        scopePath: `${CLIENTE}/01_Marca`,
      } as any)).resolves.toBeDefined();
    });

    it('consulta o estado de lápide nos dois níveis', async () => {
      const adapter = conhecimento();
      const caminho = `${CLIENTE}/01_Lapide/marca.pdf`;

      await expect(adapter.revocationState({
        scope: 'client',
        clientId: CLIENTE,
        paths: [caminho],
      } as any)).resolves.toEqual({ scope: 'client', revoked: [] });

      await adapter.forgetPath({ scope: 'client', clientId: CLIENTE, storagePath: caminho } as any);

      await expect(adapter.revocationState({
        scope: 'client',
        clientId: CLIENTE,
        paths: [caminho, `${CLIENTE}/01_Lapide/outro.pdf`],
      } as any)).resolves.toEqual({ scope: 'client', revoked: [caminho] });

      await expect(adapter.revocationState({
        scope: 'system',
        paths: [`${SYSTEM_ROOT}/tom-de-voz.pdf`],
      } as any)).resolves.toEqual({ scope: 'system', revoked: [] });
    });

    it('a lápide de uma pasta acima bloqueia o caminho do acervo geral', async () => {
      const adapter = conhecimento();
      const pasta = `${SYSTEM_ROOT}/politicas`;
      const arquivo = `${pasta}/tom.pdf`;

      await adapter.forgetPrefix({ scope: 'system', scopePath: pasta } as any);

      await expect(adapter.revocationState({ scope: 'system', paths: [arquivo] } as any))
        .resolves.toEqual({ scope: 'system', revoked: [arquivo] });
    });

    it('registra e esquece no acervo geral do sistema', async () => {
      const adapter = conhecimento();

      await expect(adapter.registerDocument({
        scope: 'system',
        scopePath: SYSTEM_ROOT,
        storagePath: `${SYSTEM_ROOT}/tom-de-voz.pdf`,
        filename: 'tom-de-voz.pdf',
        sha256: 'b'.repeat(64),
        mimeType: 'application/pdf',
        sizeBytes: 2048,
      } as any)).resolves.toMatchObject({ queued: true });

      await expect(adapter.forgetPath({
        scope: 'system',
        storagePath: `${SYSTEM_ROOT}/tom-de-voz.pdf`,
      } as any)).resolves.toBeDefined();
    });

    it('consulta os dois níveis, o dossiê, as visões e o estado de ingestão', async () => {
      const adapter = conhecimento();

      await expect(adapter.search({
        scope: 'client',
        clientId: CLIENTE,
        question: 'qual é a cor?',
      } as any)).resolves.toBeDefined();

      await expect(adapter.search({
        scope: 'system',
        question: 'qual é o tom?',
      } as any)).resolves.toBeDefined();

      await expect(adapter.scopeStatus({
        scope: 'client',
        clientId: CLIENTE,
        scopePath: `${CLIENTE}/01_Brand`,
      } as any)).resolves.toBeDefined();

      await expect(adapter.scopeStatus({
        scope: 'system',
        scopePath: SYSTEM_ROOT,
      } as any)).resolves.toBeDefined();

      await expect(adapter.dossier({ clientId: CLIENTE } as any)).resolves.toBeDefined();
      await expect(adapter.clientOverview({ clientId: CLIENTE } as any)).resolves.toBeDefined();
      await expect(adapter.systemOverview({} as any)).resolves.toBeDefined();
      await expect(adapter.regenerateDossier({ clientId: CLIENTE } as any))
        .resolves.toEqual({ queued: true });
    });

    it('extrai texto de documento pela porta de extração', async () => {
      const adapter = conhecimento();

      await expect(adapter.extractDocument({
        contentBase64: Buffer.from('conteúdo').toString('base64'),
        filename: 'nota.txt',
        mimeType: 'text/plain',
      })).resolves.toMatchObject({ text: 'texto extraído' });
    });

    it('lê o estado de um documento por id, nos dois níveis', async () => {
      const registrado = await chamar('/internal/documents', TOKEN_NORMAN, {
        scope: 'system',
        scopePath: SYSTEM_ROOT,
        storagePath: `${SYSTEM_ROOT}/manual.pdf`,
        filename: 'manual.pdf',
        sha256: 'c'.repeat(64),
      });

      const documentId = (registrado.corpo as { documentId: string }).documentId;
      const estado = await chamar(
        `/internal/documents/${documentId}`,
        TOKEN_NORMAN,
        null,
        'GET',
      );

      expect(estado.status).toBe(200);
      expect(estado.corpo).toMatchObject({ scope: 'system', clientId: null });
    });
  });

  const ROTAS_FECHADAS: Array<[string, Record<string, unknown> | null, string]> = [
    ['/internal/documents', {
      clientId: CLIENTE,
      scopePath: `${CLIENTE}/01_Brand`,
      storagePath: `${CLIENTE}/01_Brand/invasao.pdf`,
      filename: 'invasao.pdf',
      sha256: 'd'.repeat(64),
    }, 'POST'],
    ['/internal/documents/forget-path', {
      clientId: CLIENTE,
      storagePath: `${CLIENTE}/01_Brand/marca.pdf`,
    }, 'POST'],
    ['/internal/documents/forget-prefix', {
      clientId: CLIENTE,
      scopePath: `${CLIENTE}/01_Brand`,
    }, 'POST'],
    ['/internal/documents/rename-prefix', {
      clientId: CLIENTE,
      fromPath: `${CLIENTE}/01_Brand`,
      toPath: `${CLIENTE}/02_Brand`,
    }, 'POST'],
    ['/internal/documents/revocation-state', {
      clientId: CLIENTE,
      paths: [`${CLIENTE}/01_Brand/marca.pdf`],
    }, 'POST'],
    ['/internal/knowledge/search', {
      clientId: CLIENTE,
      question: 'qual é a cor da marca?',
    }, 'POST'],
    ['/internal/knowledge/scope-status', {
      clientId: CLIENTE,
      scopePath: `${CLIENTE}/01_Brand`,
    }, 'POST'],
    ['/internal/knowledge/dossier', { clientId: CLIENTE }, 'POST'],
    ['/internal/knowledge/client-overview', { clientId: CLIENTE }, 'POST'],
    ['/internal/knowledge/system-overview', {}, 'POST'],
    ['/internal/knowledge/reprocess-document', {
      clientId: CLIENTE,
      storagePath: `${CLIENTE}/01_Brand/marca.pdf`,
    }, 'POST'],
    ['/internal/knowledge/regenerate-dossier', { clientId: CLIENTE }, 'POST'],
    ['/internal/knowledge/extract-document', null, 'POST'],
  ];

  describe('o consumidor de `chat:person` não alcança documento nem conhecimento', () => {
    for (const [caminho, corpo, metodo] of ROTAS_FECHADAS) {
      it(`403 em ${metodo} ${caminho}`, async () => {
        const resposta = await chamar(caminho, TOKEN_NIPROFE, corpo, metodo);

        expect(resposta.status).toBe(403);
        expect(JSON.stringify(resposta.corpo)).toContain('niprofe');
      });
    }

    it('403 ao ler o estado de um documento por id', async () => {
      const resposta = await chamar(
        '/internal/documents/00000000-0000-4000-8000-000000000000',
        TOKEN_NIPROFE,
        null,
        'GET',
      );

      expect(resposta.status).toBe(403);
    });

    it('403 ao declarar `scope: "system"` para injetar conhecimento em todos', async () => {
      const resposta = await chamar('/internal/documents', TOKEN_NIPROFE, {
        scope: 'system',
        scopePath: SYSTEM_ROOT,
        storagePath: `${SYSTEM_ROOT}/injetado.pdf`,
        filename: 'injetado.pdf',
        sha256: 'e'.repeat(64),
      });

      expect(resposta.status).toBe(403);
      expect(JSON.stringify(resposta.corpo)).toContain('knowledge.system.write');
    });

    it('403 ao declarar `origin: "administrative"` para levantar lápide de cliente', async () => {
      const resposta = await chamar('/internal/documents', TOKEN_NIPROFE, {
        clientId: CLIENTE,
        scopePath: `${CLIENTE}/01_Brand`,
        storagePath: `${CLIENTE}/01_Brand/reenvio-invasor.pdf`,
        filename: 'reenvio-invasor.pdf',
        sha256: 'f'.repeat(64),
        origin: 'administrative',
      });

      expect(resposta.status).toBe(403);
      expect(JSON.stringify(resposta.corpo)).toContain('knowledge.client.write');
      expect(observados.nadaFoiTocado()).toEqual({ fila: 0, embedding: 0, extracao: 0 });
      const documentos = await dataSource.query(
        `SELECT 1 FROM documents WHERE storage_path = $1`,
        [`${CLIENTE}/01_Brand/reenvio-invasor.pdf`],
      );
      expect(documentos).toEqual([]);
    });

    it('403 ao declarar `origin: "administrative"` no acervo geral', async () => {
      const resposta = await chamar('/internal/documents', TOKEN_NIPROFE, {
        scope: 'system',
        scopePath: SYSTEM_ROOT,
        storagePath: `${SYSTEM_ROOT}/injetado.pdf`,
        filename: 'injetado.pdf',
        sha256: 'f'.repeat(64),
        origin: 'administrative',
      });

      expect(resposta.status).toBe(403);
      expect(JSON.stringify(resposta.corpo)).toContain('knowledge.system.write');
    });

    it('403 ao pesquisar o acervo geral do sistema', async () => {
      const resposta = await chamar('/internal/knowledge/search', TOKEN_NIPROFE, {
        scope: 'system',
        question: 'qual é o tom?',
      });

      expect(resposta.status).toBe(403);
      expect(JSON.stringify(resposta.corpo)).toContain('knowledge.system.read');
    });

    it('403 ao pesquisar o acervo de um cliente arbitrário', async () => {
      const resposta = await chamar('/internal/knowledge/search', TOKEN_NIPROFE, {
        clientId: 'cliente-que-nao-e-dele',
        question: 'qual é a cor da marca?',
      });

      expect(resposta.status).toBe(403);
      expect(JSON.stringify(resposta.corpo)).toContain('knowledge.client.read');
    });

    it('403 nas rotas administrativas de conexão de provedor', async () => {
      const revisao = await chamar('/internal/generation/connections/revisions', TOKEN_NIPROFE, {
        connectionKey: 'ollama',
        revision: 1,
        model: MODELO,
      });
      const ativacao = await chamar('/internal/generation/connections/activations', TOKEN_NIPROFE, {
        connectionKey: 'ollama',
        revision: 1,
        activationId: 'act-invadida',
      });
      const teste = await chamar('/internal/generation/connections/test', TOKEN_NIPROFE, {
        connectionKey: 'ollama',
        revision: 1,
      });

      expect([revisao.status, ativacao.status, teste.status]).toEqual([403, 403, 403]);
    });

    it('nada de banco, fila, embedding, extração ou armazenamento acontece depois do 403', async () => {
      for (const [caminho, corpo, metodo] of ROTAS_FECHADAS) {
        const resposta = await chamar(caminho, TOKEN_NIPROFE, corpo, metodo);
        expect(resposta.status).toBe(403);
      }
      await chamar(
        '/internal/documents/00000000-0000-4000-8000-000000000000',
        TOKEN_NIPROFE,
        null,
        'GET',
      );

      expect(observados.nadaFoiTocado()).toEqual({ fila: 0, embedding: 0, extracao: 0 });
      expect(consultasAoBanco).toEqual([]);
    });

    it('nenhuma linha nasceu do que foi recusado', async () => {
      const invadidos = await dataSource.query(
        `SELECT count(*)::int AS total FROM documents WHERE storage_path LIKE '%invasao%'
           OR storage_path LIKE '%injetado%'`,
      );

      expect(invadidos[0].total).toBe(0);
    });
  });

  describe('a geração continua obedecendo à allowlist e ao escopo', () => {
    it('a operação declarada da aplicação passa, no escopo de pessoa dela', async () => {
      const resposta = await chamar('/internal/generation/capabilities', TOKEN_NIPROFE, null, 'GET');

      expect(resposta.status).toBe(200);
      expect(resposta.corpo).toMatchObject({ application: 'niprofe', allowedScopes: ['person'] });
    });

    it('operação fora da lista da aplicação continua recusada', async () => {
      const resposta = await chamar('/internal/generation/v1/complete', TOKEN_NIPROFE, {
        contractVersion: 2,
        correlationId: 'corr-autorizacao',
        feature: 'briefing_final',
        actor: { userId: 'usuario-1' },
        activation: { activationId: 'act-1', connectionKey: 'ollama', connectionRevision: 1 },
        messages: [{ role: 'user', content: 'oi' }],
      });

      expect(resposta.status).toBe(403);
      expect(JSON.stringify(resposta.corpo)).toContain('briefing_final');
    });

    it('aplicação sem escopo de cliente continua sem alcançar conhecimento de cliente', async () => {
      const resposta = await chamar('/internal/generation/v1/complete', TOKEN_NIPROFE, {
        contractVersion: 2,
        correlationId: 'corr-autorizacao',
        feature: 'chat',
        actor: { userId: 'usuario-1' },
        activation: { activationId: 'act-1', connectionKey: 'ollama', connectionRevision: 1 },
        clientId: CLIENTE,
        messages: [{ role: 'user', content: 'oi' }],
      });

      expect(resposta.status).toBe(403);
      expect(JSON.stringify(resposta.corpo)).toContain('conhecimento por cliente');
    });

    it('token inválido continua sendo 401, e não 403', async () => {
      const resposta = await chamar('/internal/knowledge/system-overview', 'token-que-nao-existe', {});

      expect(resposta.status).toBe(401);
    });
  });
});
