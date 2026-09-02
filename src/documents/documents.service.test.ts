import { describe, expect, it, vi } from 'vitest';
import { Repository } from 'typeorm';
import { DocumentsService } from './documents.service';

function buildService() {
  const executed: Array<{ sql: string; params: unknown[] }> = [];
  const deleteBuilder = {
    clauses: [] as Array<{ clause: string; params: unknown }>,
    delete() {
      return deleteBuilder;
    },
    where(clause: string, params?: unknown) {
      deleteBuilder.clauses.push({ clause, params });
      return deleteBuilder;
    },
    andWhere(clause: string, params?: unknown) {
      deleteBuilder.clauses.push({ clause, params });
      return deleteBuilder;
    },
    async execute() {
      return { affected: 3 };
    },
  };

  const repository = {
    delete: vi.fn(async () => ({ affected: 1 })),
    createQueryBuilder: vi.fn(() => deleteBuilder),
    manager: {
      transaction: vi.fn(async (handler: any) =>
        handler({
          query: vi.fn(async (sql: string, params: unknown[]) => {
            executed.push({ sql, params });
            return [[], 7];
          }),
        }),
      ),
    },
  } as unknown as Repository<any>;

  return { service: new DocumentsService(repository), repository, deleteBuilder, executed };
}

describe('DocumentsService.forgetPath', () => {
  it('apaga pelo par cliente + caminho exato', async () => {
    const { service, repository } = buildService();

    const removed = await service.forgetPath({ clientId: 'cli-1', storagePath: 'Vitalis/a.pdf' });

    expect(repository.delete).toHaveBeenCalledWith({ clientId: 'cli-1', storagePath: 'Vitalis/a.pdf' });
    expect(removed).toBe(1);
  });
});

describe('DocumentsService.forgetPrefix', () => {
  it('trava no cliente e casa a própria pasta e o que está abaixo dela', async () => {
    const { service, deleteBuilder } = buildService();

    const removed = await service.forgetPrefix({ clientId: 'cli-1', scopePath: 'Vitalis/01_Brand' });

    expect(removed).toBe(3);
    expect(deleteBuilder.clauses.map((entry) => entry.clause)).toEqual([
      'client_id = :clientId',
      "(scope_path = :prefix OR left(scope_path, length(:prefix) + 1) = :prefix || '/')",
    ]);
  });

  // Nome de pasta do Norman é cheio de `_`, que é curinga de um caractere no
  // LIKE: um padrão vindo do próprio caminho apagaria pasta irmã.
  it('não usa LIKE em lugar nenhum', async () => {
    const { service, deleteBuilder } = buildService();

    await service.forgetPrefix({ clientId: 'cli-1', scopePath: 'Jonson___Co/01_Brand' });

    expect(deleteBuilder.clauses.map((entry) => entry.clause).join(' ')).not.toMatch(/like/i);
  });
});

describe('DocumentsService.renamePrefix', () => {
  it('atualiza documento e chunk na mesma transação, sem tocar em embedding', async () => {
    const { service, repository, executed } = buildService();

    const updated = await service.renamePrefix({
      clientId: 'cli-1',
      fromPath: 'Vitalis/01_Brand',
      toPath: 'Vitalis/01_Marca',
    });

    expect(updated).toBe(7);
    expect((repository.manager.transaction as any)).toHaveBeenCalledTimes(1);
    expect(executed).toHaveLength(2);
    expect(executed[0].sql).toMatch(/UPDATE documents/);
    expect(executed[1].sql).toMatch(/UPDATE document_chunks/);
    expect(executed.map((entry) => entry.sql).join(' ')).not.toMatch(/embedding/i);
    for (const entry of executed) {
      expect(entry.params).toEqual(['cli-1', 'Vitalis/01_Brand', 'Vitalis/01_Marca']);
      expect(entry.sql).not.toMatch(/like/i);
      expect(entry.sql).toMatch(/client_id = \$1/);
    }
  });

  it('move também o caminho de armazenamento do documento', async () => {
    const { service, executed } = buildService();

    await service.renamePrefix({ clientId: 'cli-1', fromPath: 'Vitalis/a', toPath: 'Vitalis/b' });

    expect(executed[0].sql).toMatch(/storage_path =/);
  });

  it('não abre transação quando origem e destino são iguais', async () => {
    const { service, repository } = buildService();

    const updated = await service.renamePrefix({
      clientId: 'cli-1',
      fromPath: 'Vitalis/01_Brand',
      toPath: 'Vitalis/01_Brand',
    });

    expect(updated).toBe(0);
    expect(repository.manager.transaction).not.toHaveBeenCalled();
  });
});
