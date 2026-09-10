import { describe, expect, it } from 'vitest';
import { consumerForToken, NORMAN_FEATURES, resolveConsumers } from './consumer-registry';
import { INTERNAL_CAPABILITIES, NORMAN_CAPABILITIES } from './internal-capabilities';
import { FEATURE_SPECS, GENERIC_COUNTERPART, GENERATION_FEATURES } from '../gateway/feature-registry';

describe('resolveConsumers', () => {
  it('sem token nenhum configurado, nenhuma aplicação existe', () => {
    expect(resolveConsumers({})).toEqual([]);
  });

  it('o Norman vem do token interno de sempre, com escopo de cliente', () => {
    expect(resolveConsumers({ INTERNAL_API_TOKEN: 'segredo-norman' })).toEqual([{
      name: 'norman',
      token: 'segredo-norman',
      features: [
        'chat',
        'chat_generic',
        'chat_stream',
        'chat_stream_generic',
        'briefing_final',
        'briefing_final_generic',
        'document_briefing',
        'document_briefing_generic',
        'workflow_briefing',
        'workflow_briefing_generic',
        'workflow_briefing_stream',
        'workflow_briefing_stream_generic',
        'job_insights',
      ],
      scopes: ['client'],
      capabilities: NORMAN_CAPABILITIES,
    }]);
  });

  /**
   * A conversa anterior à escolha do cliente é uma operação própria, e o Norman
   * troca para ela sozinho. Sem esta autorização ela chegava aqui como
   * `chat_generic` e levava 403 — verde nas duas suítes isoladas, quebrado assim
   * que os dois serviços conversavam.
   */
  it('o par genérico de cada operação vinculada do Norman está autorizado', () => {
    const vinculadas = NORMAN_FEATURES.filter(
      (feature) => FEATURE_SPECS[feature].clientBinding === 'required',
    );

    expect(vinculadas.length).toBeGreaterThan(0);
    for (const feature of vinculadas) {
      expect(NORMAN_FEATURES).toContain(GENERIC_COUNTERPART[feature]);
    }
  });

  it('toda operação autorizada ao Norman existe no registro do executor', () => {
    for (const feature of NORMAN_FEATURES) {
      expect(GENERATION_FEATURES).toContain(feature);
    }
  });

  // A separação entre os dois modos continua valendo: o par genérico é outra
  // operação, com outro prompt, que recusa `clientId`.
  it('a variante genérica autorizada continua sem vínculo com cliente', () => {
    for (const feature of NORMAN_FEATURES) {
      if (!feature.endsWith('_generic')) continue;
      expect(FEATURE_SPECS[feature]).toMatchObject({
        clientBinding: 'none',
        requiresClient: false,
        usesClientKnowledge: false,
      });
    }
  });

  it('outra aplicação não herda as variantes genéricas do Norman', () => {
    const consumers = resolveConsumers({
      INTERNAL_API_TOKEN: 'segredo-norman',
      INTERNAL_CONSUMERS: 'niprofe:NIPROFE_TOKEN:chat:person',
      NIPROFE_TOKEN: 'segredo-niprofe',
    });

    expect(consumers[1].features).toEqual(['chat']);
    expect(consumers[1].features).not.toContain('chat_generic');
  });

  it('uma aplicação nova declara as próprias operações e o próprio escopo', () => {
    const consumers = resolveConsumers({
      INTERNAL_API_TOKEN: 'segredo-norman',
      INTERNAL_CONSUMERS: 'niprofe:NIPROFE_TOKEN:chat|job_insights:person',
      NIPROFE_TOKEN: 'segredo-niprofe',
    });

    expect(consumers).toHaveLength(2);
    expect(consumers[1]).toEqual({
      name: 'niprofe',
      token: 'segredo-niprofe',
      features: ['chat', 'job_insights'],
      scopes: ['person'],
      capabilities: [],
    });
  });

  it('aplicação sem capacidade declarada não recebe nenhuma porta interna', () => {
    const consumers = resolveConsumers({
      INTERNAL_CONSUMERS: 'niprofe:NIPROFE_TOKEN:chat:person',
      NIPROFE_TOKEN: 'segredo-niprofe',
    });

    expect(consumers[0].capabilities).toEqual([]);
  });

  it('a capacidade concedida é só a declarada, e valor inventado é descartado', () => {
    const consumers = resolveConsumers({
      INTERNAL_CONSUMERS:
        'niprofe:NIPROFE_TOKEN:chat:person:documents.extract|knowledge.system.write|inventada',
      NIPROFE_TOKEN: 'segredo-niprofe',
    });

    expect(consumers[0].capabilities).toEqual(['documents.extract', 'knowledge.system.write']);
  });

  it('o Norman recebe todas as capacidades internas que os adapters dele usam', () => {
    const consumers = resolveConsumers({ INTERNAL_API_TOKEN: 'segredo-norman' });

    expect(consumers[0].capabilities).toEqual([...INTERNAL_CAPABILITIES]);
  });

  it('o token da aplicação mora na variável nomeada, não na lista', () => {
    const consumers = resolveConsumers({
      INTERNAL_CONSUMERS: 'niprofe:NIPROFE_TOKEN:chat:person',
      NIPROFE_TOKEN: 'segredo-niprofe',
    });

    expect(consumers[0].token).toBe('segredo-niprofe');
    expect(JSON.stringify(consumers)).not.toContain('NIPROFE_TOKEN:');
  });

  it('aplicação sem a variável de token preenchida não entra', () => {
    expect(resolveConsumers({ INTERNAL_CONSUMERS: 'niprofe:NIPROFE_TOKEN:chat:person' })).toEqual([]);
  });

  it('aplicação sem operação declarada não entra', () => {
    expect(resolveConsumers({
      INTERNAL_CONSUMERS: 'niprofe:NIPROFE_TOKEN::person',
      NIPROFE_TOKEN: 'x',
    })).toEqual([]);
  });

  it('sem escopo declarado, a aplicação fica no escopo de pessoa', () => {
    const consumers = resolveConsumers({
      INTERNAL_CONSUMERS: 'niprofe:NIPROFE_TOKEN:chat',
      NIPROFE_TOKEN: 'x',
    });

    expect(consumers[0].scopes).toEqual(['person']);
  });

  it('escopo inventado é descartado, e a aplicação cai no de pessoa', () => {
    const consumers = resolveConsumers({
      INTERNAL_CONSUMERS: 'niprofe:NIPROFE_TOKEN:chat:tudo',
      NIPROFE_TOKEN: 'x',
    });

    expect(consumers[0].scopes).toEqual(['person']);
  });

  it.each([
    ['Niprofe:NIPROFE_TOKEN:chat:person'],
    ['nip rofe:NIPROFE_TOKEN:chat:person'],
    ['niprofe:niprofe_token:chat:person'],
    ['niprofe:NIPROFE_TOKEN'],
    ['   '],
  ])('entrada malformada (%s) é ignorada', (entry) => {
    expect(resolveConsumers({ INTERNAL_CONSUMERS: entry, NIPROFE_TOKEN: 'x' })).toEqual([]);
  });

  it('duas aplicações convivem na mesma lista', () => {
    const consumers = resolveConsumers({
      INTERNAL_CONSUMERS: 'niprofe:NIPROFE_TOKEN:chat:person,parceiro:PARCEIRO_TOKEN:job_insights:person',
      NIPROFE_TOKEN: 'a',
      PARCEIRO_TOKEN: 'b',
    });

    expect(consumers.map((consumer) => consumer.name)).toEqual(['niprofe', 'parceiro']);
  });
});

describe('consumerForToken', () => {
  const CONSUMERS = resolveConsumers({
    INTERNAL_API_TOKEN: 'segredo-norman',
    INTERNAL_CONSUMERS: 'niprofe:NIPROFE_TOKEN:chat:person',
    NIPROFE_TOKEN: 'segredo-niprofe',
  });

  it('reconhece o Norman pelo token dele', () => {
    expect(consumerForToken('segredo-norman', CONSUMERS)?.name).toBe('norman');
  });

  it('reconhece a outra aplicação pelo token dela', () => {
    expect(consumerForToken('segredo-niprofe', CONSUMERS)?.name).toBe('niprofe');
  });

  it('token desconhecido não é aplicação nenhuma', () => {
    expect(consumerForToken('segredo-inventado', CONSUMERS)).toBeNull();
  });

  it('token de tamanho diferente não casa por prefixo', () => {
    expect(consumerForToken('segredo-norma', CONSUMERS)).toBeNull();
  });

  it('token vazio não casa com lista vazia', () => {
    expect(consumerForToken('', [])).toBeNull();
  });
});
