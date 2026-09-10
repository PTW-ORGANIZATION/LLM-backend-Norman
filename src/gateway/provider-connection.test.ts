import { describe, expect, it } from 'vitest';
import { listConnections, resolveConnection, validateBaseUrl } from './provider-connection';

describe('validateBaseUrl', () => {
  it.each([
    ['http://127.0.0.1:11434/v1'],
    ['https://api.openai.com/v1'],
    ['https://api.x.ai/v1/'],
  ])('aceita %s', (url) => {
    expect(validateBaseUrl(url)).toMatchObject({ ok: true });
  });

  it('remove a barra final para a URL não virar caminho duplo', () => {
    expect(validateBaseUrl('https://api.x.ai/v1/')).toEqual({ ok: true, url: 'https://api.x.ai/v1' });
  });

  it.each([
    ['nao-e-url', 'a URL base não é uma URL válida'],
    ['ftp://host/v1', 'protocolo não suportado na URL base: ftp:'],
    ['https://chave@api.openai.com/v1', 'a URL base não pode carregar credencial embutida'],
    ['https://api.openai.com/v1?key=abc', 'a URL base não pode carregar query nem fragmento'],
  ])('recusa %s', (url, reason) => {
    expect(validateBaseUrl(url)).toEqual({ ok: false, reason });
  });
});

describe('resolveConnection', () => {
  it('resolve o Ollama sem chave, porque ele não exige uma', () => {
    const connection = resolveConnection('ollama', {});

    expect(connection).toMatchObject({
      key: 'ollama',
      available: true,
      baseUrl: 'http://127.0.0.1:11434/v1',
      defaultModel: 'llama3.1:8b-instruct-q4_0',
    });
    expect(connection).not.toHaveProperty('apiKey');
  });

  it('conexão fora da allowlist não existe, mesmo com URL válida no ambiente', () => {
    expect(resolveConnection('provedor-inventado', { PROVEDOR_INVENTADO_BASE_URL: 'https://x/v1' }))
      .toEqual({
        key: 'provedor-inventado',
        label: 'provedor-inventado',
        protocol: 'openai_chat',
        available: false,
        reason: 'conexão "provedor-inventado" não está provisionada neste backend',
      });
  });

  it('OpenAI sem chave aparece como indisponível, e não como pronta', () => {
    expect(resolveConnection('openai', {})).toEqual({
      key: 'openai',
      label: 'OpenAI',
      protocol: 'openai_chat',
      available: false,
      reason: 'defina OPENAI_API_KEY',
    });
  });

  it('Grok sem nome de modelo aparece como indisponível, sem inventar catálogo', () => {
    expect(resolveConnection('grok', { GROK_API_KEY: 'k' })).toEqual({
      key: 'grok',
      label: 'Grok (xAI)',
      protocol: 'openai_chat',
      available: false,
      reason: 'defina GROK_MODEL',
    });
  });

  it('URL base inválida não cai para o padrão de outro provedor', () => {
    expect(resolveConnection('openai', {
      OPENAI_API_KEY: 'k',
      OPENAI_MODEL: 'gpt-x',
      OPENAI_BASE_URL: 'ftp://host',
    })).toMatchObject({
      available: false,
      reason: 'OPENAI_BASE_URL: protocolo não suportado na URL base: ftp:',
    });
  });

  it('URL com credencial embutida é recusada', () => {
    expect(resolveConnection('grok', {
      GROK_API_KEY: 'k',
      GROK_MODEL: 'grok-x',
      GROK_BASE_URL: 'https://segredo@api.x.ai/v1',
    })).toMatchObject({ available: false });
  });

  it('a lista de modelos permitidos sai do ambiente e sempre inclui o padrão', () => {
    expect(resolveConnection('openai', {
      OPENAI_API_KEY: 'k',
      OPENAI_MODEL: 'modelo-padrao',
      OPENAI_ALLOWED_MODELS: 'modelo-a, modelo-b',
    })).toMatchObject({
      available: true,
      allowedModels: ['modelo-padrao', 'modelo-a', 'modelo-b'],
    });
  });

  it('sem lista configurada, só o modelo padrão é permitido', () => {
    expect(resolveConnection('openai', { OPENAI_API_KEY: 'k', OPENAI_MODEL: 'gpt-x' }))
      .toMatchObject({ allowedModels: ['gpt-x'] });
  });

  it('a lista que já contém o padrão não o duplica', () => {
    expect(resolveConnection('openai', {
      OPENAI_API_KEY: 'k',
      OPENAI_MODEL: 'gpt-x',
      OPENAI_ALLOWED_MODELS: 'gpt-x,gpt-y',
    })).toMatchObject({ allowedModels: ['gpt-x', 'gpt-y'] });
  });

  it('a chave de um provedor não atravessa para outro', () => {
    const grok = resolveConnection('grok', {
      OPENAI_API_KEY: 'chave-da-openai',
      GROK_API_KEY: 'chave-do-grok',
      GROK_MODEL: 'grok-x',
    });

    expect(grok).toMatchObject({ available: true, baseUrl: 'https://api.x.ai/v1' });
    expect((grok as { apiKey?: string }).apiKey).toBe('chave-do-grok');
  });

  it('a listagem cobre todas as conexões provisionadas, disponíveis ou não', () => {
    const chaves = listConnections({}).map((connection) => connection.key);

    expect(chaves).toEqual(['ollama', 'openai', 'grok']);
    expect(listConnections({}).filter((connection) => connection.available)).toHaveLength(1);
  });
});
