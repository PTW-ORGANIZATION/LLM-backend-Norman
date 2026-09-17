import { describe, expect, it } from 'vitest';
import { listConnections, modeloSemRaciocinio, resolveConnection, validateBaseUrl } from './provider-connection';

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
    expect(resolveConnection('grok', {})).toEqual({
      key: 'grok',
      label: 'Grok (xAI)',
      protocol: 'openai_chat',
      available: false,
      reason: 'defina GROK_API_KEY',
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
    expect(resolveConnection('grok', {
      GROK_API_KEY: 'k',
      GROK_MODEL: 'gpt-x',
      GROK_BASE_URL: 'ftp://host',
    })).toMatchObject({
      available: false,
      reason: 'GROK_BASE_URL: protocolo não suportado na URL base: ftp:',
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
    expect(resolveConnection('grok', {
      GROK_API_KEY: 'k',
      GROK_MODEL: 'modelo-padrao',
      GROK_ALLOWED_MODELS: 'modelo-a, modelo-b',
    })).toMatchObject({
      available: true,
      allowedModels: ['modelo-padrao', 'modelo-a', 'modelo-b'],
    });
  });

  it('sem lista configurada, só o modelo padrão é permitido', () => {
    expect(resolveConnection('grok', { GROK_API_KEY: 'k', GROK_MODEL: 'gpt-x' }))
      .toMatchObject({ allowedModels: ['gpt-x'] });
  });

  it('a lista que já contém o padrão não o duplica', () => {
    expect(resolveConnection('grok', {
      GROK_API_KEY: 'k',
      GROK_MODEL: 'gpt-x',
      GROK_ALLOWED_MODELS: 'gpt-x,gpt-y',
    })).toMatchObject({ allowedModels: ['gpt-x', 'gpt-y'] });
  });

  // Chave de um provedor enviada ao endpoint de outro é vazamento de
  // credencial, e a forma de errar isso é ler a variável errada do ambiente.
  it('a chave de um provedor não atravessa para outro', () => {
    const ambiente = {
      OLLAMA_API_KEY: 'chave-do-ollama',
      OLLAMA_MODEL: 'llama-local',
      GROK_API_KEY: 'chave-do-grok',
      GROK_MODEL: 'grok-x',
    };

    const grok = resolveConnection('grok', ambiente);
    const ollama = resolveConnection('ollama', ambiente);

    expect(grok).toMatchObject({ available: true, baseUrl: 'https://api.x.ai/v1' });
    expect((grok as { apiKey?: string }).apiKey).toBe('chave-do-grok');
    expect((ollama as { apiKey?: string }).apiKey).toBe('chave-do-ollama');
  });

  it('a listagem cobre todas as conexões provisionadas, disponíveis ou não', () => {
    const chaves = listConnections({}).map((connection) => connection.key);

    expect(chaves).toEqual(['ollama', 'grok']);
    expect(listConnections({}).filter((connection) => connection.available)).toHaveLength(1);
  });
});

// Raciocínio é cobrado em tempo: achar `SELEBRAR` numa arte custava seis mil
// tokens de raciocínio e sessenta segundos, contra um e sete da mesma família
// sem raciocínio, com os mesmos três erros plantados encontrados.
describe('modeloSemRaciocinio', () => {
  it('acha a variante sem raciocínio do modelo pedido', () => {
    expect(modeloSemRaciocinio('grok-4.20', [
      'grok-4.20',
      'grok-4.20-0309-non-reasoning',
      'grok-4.20-0309-reasoning',
    ])).toBe('grok-4.20-0309-non-reasoning');
  });

  // A allowlist é a trava inteira: sem a variante permitida, a operação segue
  // no modelo da revisão em vez de alcançar um modelo que ninguém aprovou.
  it('não inventa variante que a conexão não permite', () => {
    expect(modeloSemRaciocinio('grok-4.20', ['grok-4.20'])).toBeNull();
    expect(modeloSemRaciocinio('grok-4.20', [])).toBeNull();
  });

  it('não devolve variante de outro modelo', () => {
    expect(modeloSemRaciocinio('grok-4.20', ['grok-4.5-0309-non-reasoning'])).toBeNull();
  });

  it('não devolve a variante que raciocina', () => {
    expect(modeloSemRaciocinio('grok-4.20', ['grok-4.20-0309-reasoning'])).toBeNull();
  });

  it('não devolve o próprio modelo quando ele já termina em non-reasoning', () => {
    const permitidos = ['grok-4.20-non-reasoning'];

    expect(modeloSemRaciocinio('grok-4.20-non-reasoning', permitidos)).toBeNull();
  });

  it('modelo vazio não escolhe nada', () => {
    expect(modeloSemRaciocinio('  ', ['grok-4.20-0309-non-reasoning'])).toBeNull();
  });
});
