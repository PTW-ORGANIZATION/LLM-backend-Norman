import express from 'express';
import type { Server } from 'node:http';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { NormanDocumentContentAdapter } from '../src/ingestion/norman-document-content.adapter';

const TOKEN = 'token-interno-do-norman';
const CLIENTE = 'contrato-cliente-a';
const SYSTEM_ROOT = '_Conhecimento geral do sistema';

vi.mock('@norman/core/env', () => ({
  env: { internalApiToken: TOKEN },
  requireEnv: () => 'postgres://nao-usado',
}));

vi.mock('@norman/db', () => ({
  db: {},
  pool: {},
}));

const { createKnowledgeRouter } = await import('@norman/modules/knowledge/knowledge.routes');
const { AppError } = await import('@norman/core/errors');

const VERSAO_A = Buffer.from('a primeira versão da política');
const VERSAO_B = Buffer.from('a segunda versão da política');

function hashDe(conteudo: Buffer) {
  return createHash('sha256').update(conteudo).digest('hex');
}

const chamadas: Array<{ storagePath: string; expectedSha256: string | null }> = [];

async function readRepositoryFile(storagePath: string, expectedSha256?: string | null) {
  chamadas.push({ storagePath, expectedSha256: expectedSha256 ?? null });
  const vigente = VERSAO_B;
  const sha256 = hashDe(vigente);
  if (expectedSha256 && expectedSha256 !== sha256) {
    throw new AppError('substituída', 409, 'CONTENT_SUPERSEDED');
  }
  return { content: vigente, filename: 'politica.md', mimeType: 'text/markdown', sha256 };
}

describe('busca de bytes do repositório, pela rede, entre os dois serviços', () => {
  let server: Server;
  let adapter: NormanDocumentContentAdapter;

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use(createKnowledgeRouter({
      readRepositoryFile: readRepositoryFile as never,
      listClients: async () => [
        { id: CLIENTE, name: 'Cliente A', assetFolderName: CLIENTE } as never,
      ],
    }));
    app.use((error: any, _req: any, res: any, _next: any) => {
      res.status(error?.statusCode || 500).json({ code: error?.code, message: error?.message });
    });

    server = await new Promise<Server>((resolve) => {
      const criado = app.listen(0, '127.0.0.1', () => resolve(criado));
    });
    const porta = (server.address() as { port: number }).port;

    adapter = new NormanDocumentContentAdapter({
      get: (chave: string, padrao?: unknown) => {
        if (chave === 'ingestion.normanBaseUrl') return `http://127.0.0.1:${porta}`;
        if (chave === 'internal.token') return TOKEN;
        return padrao;
      },
    } as unknown as ConfigService);
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it('o hash pedido pelo executor chega ao leitor do Norman com o mesmo nome de campo', async () => {
    chamadas.length = 0;

    const arquivo = await adapter.fetch({
      scope: 'client',
      clientId: CLIENTE,
      storagePath: `${CLIENTE}/01_Brand/politica.md`,
      filename: 'politica.md',
      expectedSha256: hashDe(VERSAO_B),
    });

    expect(chamadas).toEqual([{
      storagePath: `${CLIENTE}/01_Brand/politica.md`,
      expectedSha256: hashDe(VERSAO_B),
    }]);
    expect(arquivo.content.toString()).toBe(VERSAO_B.toString());
    expect(createHash('sha256').update(arquivo.content).digest('hex')).toBe(hashDe(VERSAO_B));
  });

  it('pedir a geração anterior é recusado em vez de devolver bytes de outra versão', async () => {
    await expect(adapter.fetch({
      scope: 'client',
      clientId: CLIENTE,
      storagePath: `${CLIENTE}/01_Brand/politica.md`,
      filename: 'politica.md',
      expectedSha256: hashDe(VERSAO_A),
    })).rejects.toThrow(/devolveu 409/);
  });

  it('sem hash declarado o Norman entrega a geração vigente do caminho', async () => {
    chamadas.length = 0;

    const arquivo = await adapter.fetch({
      scope: 'client',
      clientId: CLIENTE,
      storagePath: `${CLIENTE}/01_Brand/politica.md`,
      filename: 'politica.md',
      expectedSha256: null,
    });

    expect(chamadas[0].expectedSha256).toBeNull();
    expect(arquivo.content.toString()).toBe(VERSAO_B.toString());
  });

  it('o acervo geral também viaja com o hash e sem cliente', async () => {
    chamadas.length = 0;

    await adapter.fetch({
      scope: 'system',
      clientId: null,
      storagePath: `${SYSTEM_ROOT}/politica.md`,
      filename: 'politica.md',
      expectedSha256: hashDe(VERSAO_B),
    });

    expect(chamadas).toEqual([{
      storagePath: `${SYSTEM_ROOT}/politica.md`,
      expectedSha256: hashDe(VERSAO_B),
    }]);
  });
});
