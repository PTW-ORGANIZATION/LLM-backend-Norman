import { describe, expect, it } from 'vitest';

import { resolveConnection, PROVIDER_SPECS } from '../src/gateway/provider-connection';
import { resolverConexao, PROVEDORES } from '@norman/modules/ai/conexao-do-provedor';

/**
 * O registro de conexões, comparado entre os dois serviços.
 *
 * As duas pontas precisam concordar sobre **quais variáveis configuram cada
 * provedor**. Se divergirem, o ambiente que faz o executor funcionar deixa o
 * Norman sem provedor — ou, pior, faz cada um falar com um endpoint diferente
 * enquanto a tela mostra uma conexão só. Um `.env` atende os dois, e é esta
 * suíte que sustenta essa promessa.
 *
 * A comparação é de decisão, e não de texto: mesma origem de ambiente, mesma
 * disponibilidade, mesma URL base, mesma chave e mesmo modelo padrão. O motivo
 * da indisponibilidade também é comparado, porque é ele que diz a quem opera
 * qual variável falta.
 */

const AMBIENTES: Array<{ nome: string; env: Record<string, string | undefined> }> = [
  { nome: 'ambiente vazio', env: {} },
  {
    nome: 'produção com as duas conexões configuradas',
    env: {
      OLLAMA_OPENAI_BASE_URL: 'https://ollama.ptwag.com/v1',
      OLLAMA_MODEL: 'llama3.1:8b-instruct-q4_0',
      GROK_BASE_URL: 'https://api.x.ai/v1',
      GROK_API_KEY: 'xai-chave-de-teste',
      GROK_MODEL: 'grok-4.20',
    },
  },
  {
    nome: 'Grok escolhido na tela sem a chave provisionada',
    env: { GROK_BASE_URL: 'https://api.x.ai/v1', GROK_MODEL: 'grok-4.20' },
  },
  {
    nome: 'Grok com chave e sem modelo',
    env: { GROK_API_KEY: 'xai-chave-de-teste' },
  },
  {
    nome: 'URL base com barra no fim',
    env: { OLLAMA_OPENAI_BASE_URL: 'https://ollama.ptwag.com/v1/' },
  },
  {
    nome: 'URL base que não é URL',
    env: { OLLAMA_OPENAI_BASE_URL: 'ollama.ptwag.com' },
  },
  {
    nome: 'URL base com protocolo não suportado',
    env: { OLLAMA_OPENAI_BASE_URL: 'ftp://ollama.ptwag.com/v1' },
  },
  {
    nome: 'variáveis presentes e em branco',
    env: {
      OLLAMA_OPENAI_BASE_URL: '   ',
      OLLAMA_MODEL: '',
      GROK_API_KEY: '  ',
      GROK_BASE_URL: '',
    },
  },
  {
    nome: 'Ollama com chave, que ele não exige',
    env: { OLLAMA_API_KEY: 'sk-nao-obrigatoria' },
  },
];

describe('as duas pontas leem as mesmas variáveis de cada conexão', () => {
  it('o registro tem as mesmas chaves nos dois serviços', () => {
    expect(Object.keys(PROVEDORES).sort()).toEqual(Object.keys(PROVIDER_SPECS).sort());
  });

  it.each(Object.keys(PROVIDER_SPECS))('%s se configura pelas mesmas variáveis', (chave) => {
    const executor = PROVIDER_SPECS[chave];
    const norman = PROVEDORES[chave];
    expect({
      baseUrlEnv: norman.baseUrlEnv,
      apiKeyEnv: norman.apiKeyEnv,
      modelEnv: norman.modelEnv,
      defaultBaseUrl: norman.defaultBaseUrl,
      defaultModel: norman.defaultModel,
      requiresApiKey: norman.requiresApiKey,
    }).toEqual({
      baseUrlEnv: executor.baseUrlEnv,
      apiKeyEnv: executor.apiKeyEnv,
      modelEnv: executor.modelEnv,
      defaultBaseUrl: executor.defaultBaseUrl,
      defaultModel: executor.defaultModel,
      requiresApiKey: executor.requiresApiKey,
    });
  });
});

describe('as duas resoluções decidem igual', () => {
  const chaves = [...Object.keys(PROVIDER_SPECS), 'openai', 'inexistente', '', '  OLLAMA  '];

  for (const { nome, env } of AMBIENTES) {
    it.each(chaves)(`${nome}: a conexão "%s"`, (chave) => {
      const doExecutor = resolveConnection(chave, env);
      const doNorman = resolverConexao(chave, env);

      expect(doNorman.available).toBe(doExecutor.available);

      if (doExecutor.available && doNorman.available) {
        expect({
          key: doNorman.key,
          baseUrl: doNorman.baseUrl,
          apiKey: doNorman.apiKey,
          defaultModel: doNorman.defaultModel,
        }).toEqual({
          key: doExecutor.key,
          baseUrl: doExecutor.baseUrl,
          apiKey: doExecutor.apiKey,
          defaultModel: doExecutor.defaultModel,
        });
        return;
      }

      if (!doExecutor.available && !doNorman.available) {
        expect(doNorman.reason).toBe(doExecutor.reason);
      }
    });
  }
});
