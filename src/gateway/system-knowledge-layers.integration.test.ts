import { DataSource } from 'typeorm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { toSql } from 'pgvector';
import { DocumentChunk } from '../documents/document-chunk.entity';
import { DocumentRecord } from '../documents/document.entity';
import { DocumentChunksService } from '../documents/document-chunks.service';
import { DocumentsService } from '../documents/documents.service';
import { KnowledgeNote } from '../knowledge/knowledge-note.entity';
import { KnowledgeNotesService } from '../knowledge/knowledge-notes.service';
import { ConnectionActivation } from './connection-activation.entity';
import { ConnectionRevision } from './connection-revision.entity';
import { ConnectionRevisionsService } from './connection-revisions.service';
import { GenerationExecution } from './generation-execution.entity';
import { GenerationService } from './generation.service';
import type { LlmProvider } from './llm-provider.port';
import { startIntegrationPostgres, type EmbeddedPostgres } from '../test/embedded-postgres';
import { KNOWLEDGE_MIGRATIONS } from '../test/knowledge-migrations';
import type { GenerateDto } from './generation.dto';

const CLIENT_A = 'camada-a';
const CLIENT_B = 'camada-b';
const SYSTEM_ROOT = '_Conhecimento geral do sistema';

const AMBIENTE = {
  OLLAMA_MODEL: 'llama-local',
  OLLAMA_ALLOWED_MODELS: 'llama-local',
  OPENAI_ALLOWED_MODELS: '',
};

function embedding() {
  return Array.from({ length: 768 }, (_, index) => (index % 7) / 10);
}

/**
 * A geração vinculada a cliente consultando as duas camadas de verdade.
 *
 * O banco é real, os dois filtros são reais e a mesclagem é a do executor. O
 * que é falso aqui é só o provedor externo — e ele entra depois de tudo o que
 * decide escopo já ter acontecido.
 */
describe('geração por cliente com a camada geral do sistema', () => {
  let embedded: EmbeddedPostgres;
  let dataSource: DataSource;
  let documentsService: DocumentsService;
  let chunksService: DocumentChunksService;
  let notesService: KnowledgeNotesService;
  let revisionsService: ConnectionRevisionsService;
  let ambienteOriginal: Record<string, string | undefined>;

  function buildService(
    config: Record<string, unknown> = {},
    falhas: { layer?: 'client' | 'system'; embedding?: boolean } = {},
  ) {
    const generate = vi.fn(async () => ({
      text: 'resposta do provedor',
      promptTokens: 10,
      completionTokens: 2,
    })) as unknown as Mock;
    const provider = {
      protocol: 'openai_chat',
      generate,
      generateStream: async function* vazio() {
        yield { kind: 'completed' as const, promptTokens: 0, completionTokens: 0 };
      },
      capabilities: () => ({
        streaming: false,
        structuredOutput: true,
        vision: false,
        cancellation: true,
      }),
    } as unknown as LlmProvider;

    const embed = vi.fn(async () => {
      if (falhas.embedding) throw new Error('ollama fora do ar');
      return embedding();
    });
    const buscas: string[] = [];
    const chunks = {
      searchSimilar: (input: Parameters<DocumentChunksService['searchSimilar']>[0]) => {
        buscas.push(input.scope.kind);
        if (falhas.layer === input.scope.kind) {
          return Promise.reject(new Error(`busca do nível ${input.scope.kind} falhou`));
        }
        return chunksService.searchSimilar(input);
      },
    } as unknown as DocumentChunksService;

    const service = new GenerationService(
      { get: (key: string, fallback?: unknown) => (key in config ? config[key] : fallback) } as any,
      provider,
      { embed } as any,
      chunks,
      notesService,
      dataSource.getRepository(GenerationExecution),
      revisionsService,
    );

    return { service, generate, embed, buscas };
  }

  async function seedClient(clientId: string, filename: string, content: string) {
    const scopePath = `${clientId}/01_Brand`;
    const { document } = await documentsService.registerClientDocument({
      scope: 'client',
      clientId,
      scopePath,
      storagePath: `${scopePath}/${filename}`,
      filename,
      sha256: `${clientId}-${filename}`.padEnd(64, '0').slice(0, 64),
    });
    await dataSource.query(
      `INSERT INTO document_chunks
         (document_id, knowledge_scope, client_id, scope_path, chunk_index, page_number, content,
          embedding, embedding_model, embedding_dimensions)
       VALUES ($1, 'client', $2, $3, 0, 2, $4, $5::vector, 'nomic-embed-text', 768)`,
      [document.id, clientId, scopePath, content, toSql(embedding())],
    );
    return document.id;
  }

  async function seedSystem(filename: string, content: string) {
    const { document } = await documentsService.registerClientDocument({
      scope: 'system',
      clientId: null,
      scopePath: SYSTEM_ROOT,
      storagePath: `${SYSTEM_ROOT}/${filename}`,
      filename,
      sha256: `system-${filename}`.padEnd(64, '0').slice(0, 64),
    });
    await dataSource.query(
      `INSERT INTO document_chunks
         (document_id, knowledge_scope, client_id, scope_path, chunk_index, page_number, content,
          embedding, embedding_model, embedding_dimensions)
       VALUES ($1, 'system', NULL, $2, 0, 7, $3, $4::vector, 'nomic-embed-text', 768)`,
      [document.id, SYSTEM_ROOT, content, toSql(embedding())],
    );
    return document.id;
  }

  function pedido(overrides: Partial<GenerateDto> = {}): GenerateDto {
    return {
      contractVersion: 2,
      correlationId: 'corr-camadas',
      feature: 'chat',
      actor: { userId: 'user-1' },
      activation: { activationId: 'act-1', connectionKey: 'ollama', connectionRevision: 3 },
      clientId: CLIENT_A,
      retrievalQuestion: 'qual é o tom e a cor?',
      messages: [{ role: 'user', content: 'qual é o tom e a cor?' }],
      ...overrides,
    } as GenerateDto;
  }

  function systemPrompt(generate: Mock): string {
    return generate.mock.calls[0][1].messages
      .filter((message: any) => message.role === 'system')
      .map((message: any) => message.content)
      .join('\n');
  }

  beforeAll(async () => {
    embedded = await startIntegrationPostgres({
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
    dataSource = new DataSource(embedded.options);
    await dataSource.initialize();
    await dataSource.runMigrations();
    documentsService = new DocumentsService(dataSource.getRepository(DocumentRecord));
    chunksService = new DocumentChunksService(dataSource.getRepository(DocumentChunk));
    notesService = new KnowledgeNotesService(dataSource.getRepository(KnowledgeNote));
    revisionsService = new ConnectionRevisionsService(
      dataSource.getRepository(ConnectionRevision),
      dataSource.getRepository(ConnectionActivation),
    );

    ambienteOriginal = {};
    for (const [chave, valor] of Object.entries(AMBIENTE)) {
      ambienteOriginal[chave] = process.env[chave];
      process.env[chave] = valor;
    }
  }, 180000);

  afterAll(async () => {
    for (const [chave, valor] of Object.entries(ambienteOriginal)) {
      if (valor === undefined) delete process.env[chave];
      else process.env[chave] = valor;
    }
    if (dataSource?.isInitialized) await dataSource.destroy();
    await embedded?.stop();
  });

  beforeEach(async () => {
    await dataSource.query(`DELETE FROM connection_activations`);
    await dataSource.query(`DELETE FROM connection_revisions`);
    await revisionsService.sync({ connectionKey: 'ollama', revision: 3, model: 'llama-local' });
    await revisionsService.confirmActivation({
      connectionKey: 'ollama',
      revision: 3,
      activationId: 'act-1',
    });
    await dataSource.query(`DELETE FROM generation_executions`);
    await dataSource.query(`DELETE FROM document_chunks`);
    await dataSource.query(`DELETE FROM knowledge_notes`);
    await dataSource.query(`DELETE FROM documents`);
  });

  it('a fonte geral compõe o contexto do cliente A e do cliente B', async () => {
    const geral = await seedSystem('tom-de-voz.pdf', 'o tom de voz do Norman e direto');
    await seedClient(CLIENT_A, 'marca-a.pdf', 'a cor do cliente A e azul-cobalto');
    await seedClient(CLIENT_B, 'marca-b.pdf', 'a cor do cliente B e verde-musgo');

    const primeiro = buildService();
    const respostaA = await primeiro.service.generate(pedido({ clientId: CLIENT_A }));
    const contextoA = systemPrompt(primeiro.generate);

    const segundo = buildService();
    const respostaB = await segundo.service.generate(
      pedido({ clientId: CLIENT_B, correlationId: 'corr-camadas-b' }),
    );
    const contextoB = systemPrompt(segundo.generate);

    expect(contextoA).toContain('[sistema | tom-de-voz.pdf, página 7] o tom de voz do Norman e direto');
    expect(contextoB).toContain('[sistema | tom-de-voz.pdf, página 7] o tom de voz do Norman e direto');
    expect(respostaA.citations).toContainEqual(
      expect.objectContaining({ scope: 'system', documentId: geral }),
    );
    expect(respostaB.citations).toContainEqual(
      expect.objectContaining({ scope: 'system', documentId: geral }),
    );
  });

  it('a fonte privada de A não entra na geração de B, e vice-versa', async () => {
    await seedSystem('tom-de-voz.pdf', 'o tom de voz do Norman e direto');
    await seedClient(CLIENT_A, 'marca-a.pdf', 'a cor do cliente A e azul-cobalto');
    await seedClient(CLIENT_B, 'marca-b.pdf', 'a cor do cliente B e verde-musgo');

    const paraA = buildService();
    await paraA.service.generate(pedido({ clientId: CLIENT_A }));
    const paraB = buildService();
    await paraB.service.generate(pedido({ clientId: CLIENT_B, correlationId: 'corr-camadas-b' }));

    expect(systemPrompt(paraA.generate)).not.toContain('verde-musgo');
    expect(systemPrompt(paraB.generate)).not.toContain('azul-cobalto');
  });

  // A precedência é o que o plano pede em voz alta: quando a regra geral e a do
  // cliente disputam o mesmo espaço, é a do cliente que entra.
  it('conflito entre a regra geral e a do cliente resolve pelo cliente', async () => {
    await seedSystem('padrao.pdf', 'a cor padrao do Norman e verde institucional');
    await seedClient(CLIENT_A, 'marca-a.pdf', 'a cor do cliente A e azul-cobalto');

    const { service, generate } = buildService({ 'knowledge.retrievalMaxSnippets': 1 });
    const outcome = await service.generate(pedido({ clientId: CLIENT_A }));

    const contexto = systemPrompt(generate);
    expect(contexto).toContain('azul-cobalto');
    expect(contexto).not.toContain('verde institucional');
    expect(outcome.citations).toHaveLength(1);
    expect(outcome.citations[0].scope).toBe('client');
  });

  it('o cabeçalho do contexto declara qual camada manda', async () => {
    await seedSystem('padrao.pdf', 'a cor padrao do Norman e verde institucional');
    await seedClient(CLIENT_A, 'marca-a.pdf', 'a cor do cliente A e azul-cobalto');

    const { service, generate } = buildService();
    await service.generate(pedido({ clientId: CLIENT_A }));

    expect(systemPrompt(generate)).toContain('vale a do cliente');
  });

  // Ampliar o contrato do modo genérico é decisão de produto com operação
  // própria, e não efeito colateral da camada geral existir.
  it('operação genérica não recebe a camada geral nem a de cliente', async () => {
    await seedSystem('tom-de-voz.pdf', 'o tom de voz do Norman e direto');
    const { service, generate } = buildService();

    const outcome = await service.generate({
      ...pedido(),
      feature: 'chat_generic',
      clientId: undefined,
      retrievalQuestion: undefined,
    } as GenerateDto);

    expect(systemPrompt(generate)).not.toContain('o tom de voz do Norman e direto');
    expect(outcome.citations).toEqual([]);
    expect(outcome.evidence).toBeNull();
    expect(outcome.systemKnowledgeAvailable).toBe(false);
  });

  it('revogação geral pendente tira a camada geral e mantém a do cliente', async () => {
    await seedSystem('tom-de-voz.pdf', 'o tom de voz do Norman e direto');
    await seedClient(CLIENT_A, 'marca-a.pdf', 'a cor do cliente A e azul-cobalto');

    const { service, generate } = buildService();
    const outcome = await service.generate(
      pedido({ clientId: CLIENT_A, systemKnowledgeUnavailable: true }),
    );

    const contexto = systemPrompt(generate);
    expect(contexto).not.toContain('o tom de voz do Norman e direto');
    expect(contexto).toContain('azul-cobalto');
    expect(contexto).toContain('camada de conhecimento geral do Norman não pôde ser consultada');
    expect(outcome.systemKnowledgeAvailable).toBe(false);
    expect(outcome.citations.every((citation) => citation.scope === 'client')).toBe(true);
    expect(outcome.evidence?.layers.system).toBeNull();
    expect(outcome.evidence?.layers.client).toMatchObject({ used: 1 });
  });

  // Retirar a camada geral não pode virar licença para consultar mais largo: o
  // acervo dos outros clientes continua fora, e a resposta não fica sem trava.
  it('retirar a camada geral não libera consulta ampla', async () => {
    await seedSystem('tom-de-voz.pdf', 'o tom de voz do Norman e direto');
    await seedClient(CLIENT_A, 'marca-a.pdf', 'a cor do cliente A e azul-cobalto');
    await seedClient(CLIENT_B, 'marca-b.pdf', 'a cor do cliente B e verde-musgo');

    const { service, generate } = buildService();
    await service.generate(pedido({ clientId: CLIENT_A, systemKnowledgeUnavailable: true }));

    expect(systemPrompt(generate)).not.toContain('verde-musgo');
  });

  it('a revogação geral confirmada apaga a evidência para os dois clientes', async () => {
    await seedSystem('tom-de-voz.pdf', 'o tom de voz do Norman e direto');
    await seedClient(CLIENT_A, 'marca-a.pdf', 'a cor do cliente A e azul-cobalto');
    await seedClient(CLIENT_B, 'marca-b.pdf', 'a cor do cliente B e verde-musgo');

    await dataSource.query(`DELETE FROM documents WHERE knowledge_scope = 'system'`);

    const paraA = buildService();
    const respostaA = await paraA.service.generate(pedido({ clientId: CLIENT_A }));
    const paraB = buildService();
    const respostaB = await paraB.service.generate(
      pedido({ clientId: CLIENT_B, correlationId: 'corr-camadas-b' }),
    );

    expect(systemPrompt(paraA.generate)).not.toContain('o tom de voz do Norman e direto');
    expect(systemPrompt(paraB.generate)).not.toContain('o tom de voz do Norman e direto');
    expect(respostaA.citations.every((citation) => citation.scope === 'client')).toBe(true);
    expect(respostaB.citations.every((citation) => citation.scope === 'client')).toBe(true);
  });

  it('a auditoria registra a camada de cada citação e o estado da camada geral', async () => {
    await seedSystem('tom-de-voz.pdf', 'o tom de voz do Norman e direto');
    await seedClient(CLIENT_A, 'marca-a.pdf', 'a cor do cliente A e azul-cobalto');

    const { service } = buildService();
    await service.generate(pedido({ clientId: CLIENT_A }));

    const [execucao] = await dataSource
      .getRepository(GenerationExecution)
      .find({ where: { correlationId: 'corr-camadas' } });

    const evidencia = execucao.evidence as any;
    expect(evidencia.systemKnowledgeAvailable).toBe(true);
    expect(evidencia.knowledgeLayers.client).toMatchObject({ used: 1 });
    expect(evidencia.knowledgeLayers.system).toMatchObject({ used: 1 });
    expect(new Set(evidencia.citations.map((citation: any) => citation.scope))).toEqual(
      new Set(['client', 'system']),
    );
  });

  it('a camada geral vazia não é confundida com camada geral retida', async () => {
    await seedClient(CLIENT_A, 'marca-a.pdf', 'a cor do cliente A e azul-cobalto');

    const { service } = buildService();
    const outcome = await service.generate(pedido({ clientId: CLIENT_A }));

    expect(outcome.systemKnowledgeAvailable).toBe(true);
    expect(outcome.evidence?.layers.system).toMatchObject({ considered: 0, sufficient: false });
  });
  describe('falha de uma camada preserva a outra', () => {
    it('a busca do sistema falhando mantém o cliente no contexto', async () => {
      await seedSystem('tom-de-voz.pdf', 'o tom de voz do Norman e direto');
      await seedClient(CLIENT_A, 'marca-a.pdf', 'a cor do cliente A e azul-cobalto');

      const { service, generate } = buildService({}, { layer: 'system' });
      const outcome = await service.generate(pedido({ clientId: CLIENT_A }));

      const contexto = systemPrompt(generate);
      expect(contexto).toContain('azul-cobalto');
      expect(contexto).not.toContain('o tom de voz do Norman e direto');
      expect(contexto).toContain('camada de conhecimento geral do Norman não pôde ser consultada');
      expect(contexto).not.toContain('Consulta ao acervo do cliente indisponível');
      expect(outcome.knowledgeUnavailable).toBe(false);
      expect(outcome.systemKnowledgeAvailable).toBe(false);
      expect(outcome.citations).toHaveLength(1);
      expect(outcome.citations[0].scope).toBe('client');
      expect(outcome.evidence?.layers.client).toMatchObject({ used: 1 });
      expect(outcome.evidence?.layers.system).toBeNull();
    });

    it('a busca do cliente falhando mantém o sistema no contexto', async () => {
      await seedSystem('tom-de-voz.pdf', 'o tom de voz do Norman e direto');
      await seedClient(CLIENT_A, 'marca-a.pdf', 'a cor do cliente A e azul-cobalto');

      const { service, generate } = buildService({}, { layer: 'client' });
      const outcome = await service.generate(pedido({ clientId: CLIENT_A }));

      const contexto = systemPrompt(generate);
      expect(contexto).toContain('o tom de voz do Norman e direto');
      expect(contexto).not.toContain('azul-cobalto');
      expect(contexto).toContain('Consulta ao acervo do cliente indisponível');
      expect(contexto).not.toContain('camada de conhecimento geral do Norman não pôde ser consultada');
      expect(outcome.knowledgeUnavailable).toBe(true);
      expect(outcome.systemKnowledgeAvailable).toBe(true);
      expect(outcome.citations).toHaveLength(1);
      expect(outcome.citations[0].scope).toBe('system');
      expect(outcome.evidence?.layers.system).toMatchObject({ used: 1 });
      expect(outcome.evidence?.layers.client).toBeNull();
    });

    it('a retenção do cliente mantém a camada geral', async () => {
      await seedSystem('tom-de-voz.pdf', 'o tom de voz do Norman e direto');
      await seedClient(CLIENT_A, 'marca-a.pdf', 'a cor do cliente A e azul-cobalto');

      const { service, generate } = buildService();
      const outcome = await service.generate(
        pedido({ clientId: CLIENT_A, knowledgeUnavailable: true }),
      );

      const contexto = systemPrompt(generate);
      expect(contexto).toContain('o tom de voz do Norman e direto');
      expect(contexto).not.toContain('azul-cobalto');
      expect(outcome.knowledgeUnavailable).toBe(true);
      expect(outcome.systemKnowledgeAvailable).toBe(true);
      expect(outcome.citations.every((citation) => citation.scope === 'system')).toBe(true);
    });

    it('a retenção do cliente não consulta o acervo dele', async () => {
      await seedSystem('tom-de-voz.pdf', 'o tom de voz do Norman e direto');
      await seedClient(CLIENT_A, 'marca-a.pdf', 'a cor do cliente A e azul-cobalto');

      const { service, buscas } = buildService();
      await service.generate(pedido({ clientId: CLIENT_A, knowledgeUnavailable: true }));

      expect(buscas).toEqual(['system']);
    });

    it('a retenção do sistema não consulta o acervo geral', async () => {
      await seedSystem('tom-de-voz.pdf', 'o tom de voz do Norman e direto');
      await seedClient(CLIENT_A, 'marca-a.pdf', 'a cor do cliente A e azul-cobalto');

      const { service, buscas } = buildService();
      await service.generate(pedido({ clientId: CLIENT_A, systemKnowledgeUnavailable: true }));

      expect(buscas).toEqual(['client']);
    });

    it('as duas retenções juntas não consultam nada e avisam as duas camadas', async () => {
      await seedSystem('tom-de-voz.pdf', 'o tom de voz do Norman e direto');
      await seedClient(CLIENT_A, 'marca-a.pdf', 'a cor do cliente A e azul-cobalto');

      const { service, generate, buscas, embed } = buildService();
      const outcome = await service.generate(pedido({
        clientId: CLIENT_A,
        knowledgeUnavailable: true,
        systemKnowledgeUnavailable: true,
      }));

      expect(buscas).toEqual([]);
      expect(embed).not.toHaveBeenCalled();
      const contexto = systemPrompt(generate);
      expect(contexto).toContain('Consulta ao acervo do cliente indisponível');
      expect(contexto).toContain('camada de conhecimento geral do Norman não pôde ser consultada');
      expect(outcome.citations).toEqual([]);
      expect(outcome.evidence).toBeNull();
    });

    it('a falha do embedding marca as duas camadas e não produz evidência', async () => {
      await seedSystem('tom-de-voz.pdf', 'o tom de voz do Norman e direto');
      await seedClient(CLIENT_A, 'marca-a.pdf', 'a cor do cliente A e azul-cobalto');

      const { service, generate, buscas } = buildService({}, { embedding: true });
      const outcome = await service.generate(pedido({ clientId: CLIENT_A }));

      expect(buscas).toEqual([]);
      const contexto = systemPrompt(generate);
      expect(contexto).toContain('Consulta ao acervo do cliente indisponível');
      expect(contexto).toContain('camada de conhecimento geral do Norman não pôde ser consultada');
      expect(outcome.knowledgeUnavailable).toBe(true);
      expect(outcome.systemKnowledgeAvailable).toBe(false);
      expect(outcome.citations).toEqual([]);
      expect(outcome.evidence).toBeNull();
    });

    it('a auditoria da falha do sistema não acusa a camada do cliente', async () => {
      await seedSystem('tom-de-voz.pdf', 'o tom de voz do Norman e direto');
      await seedClient(CLIENT_A, 'marca-a.pdf', 'a cor do cliente A e azul-cobalto');

      const { service } = buildService({}, { layer: 'system' });
      await service.generate(pedido({ clientId: CLIENT_A }));

      const [execucao] = await dataSource
        .getRepository(GenerationExecution)
        .find({ where: { correlationId: 'corr-camadas' } });

      const evidencia = execucao.evidence as any;
      expect(evidencia.knowledgeUnavailable).toBe(false);
      expect(evidencia.systemKnowledgeAvailable).toBe(false);
      expect(evidencia.knowledgeLayers.client).toMatchObject({ used: 1 });
      expect(evidencia.knowledgeLayers.system).toBeNull();
      expect(evidencia.citations.map((citation: any) => citation.scope)).toEqual(['client']);
    });

    it('a auditoria da falha do cliente não acusa a camada geral', async () => {
      await seedSystem('tom-de-voz.pdf', 'o tom de voz do Norman e direto');
      await seedClient(CLIENT_A, 'marca-a.pdf', 'a cor do cliente A e azul-cobalto');

      const { service } = buildService({}, { layer: 'client' });
      await service.generate(pedido({ clientId: CLIENT_A }));

      const [execucao] = await dataSource
        .getRepository(GenerationExecution)
        .find({ where: { correlationId: 'corr-camadas' } });

      const evidencia = execucao.evidence as any;
      expect(evidencia.knowledgeUnavailable).toBe(true);
      expect(evidencia.systemKnowledgeAvailable).toBe(true);
      expect(evidencia.knowledgeLayers.system).toMatchObject({ used: 1 });
      expect(evidencia.knowledgeLayers.client).toBeNull();
      expect(evidencia.citations.map((citation: any) => citation.scope)).toEqual(['system']);
    });

    it('a falha de uma camada não libera o acervo do outro cliente', async () => {
      await seedSystem('tom-de-voz.pdf', 'o tom de voz do Norman e direto');
      await seedClient(CLIENT_A, 'marca-a.pdf', 'a cor do cliente A e azul-cobalto');
      await seedClient(CLIENT_B, 'marca-b.pdf', 'a cor do cliente B e verde-musgo');

      const { service, generate } = buildService({}, { layer: 'system' });
      await service.generate(pedido({ clientId: CLIENT_A }));

      expect(systemPrompt(generate)).not.toContain('verde-musgo');
    });
  });
});
