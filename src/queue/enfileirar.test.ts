import { describe, expect, it, vi } from 'vitest';
import type { Queue } from 'bullmq';

import { enfileirarLiberandoOId } from './enfileirar';

type JobFalso = {
  isCompleted: () => Promise<boolean>;
  isFailed: () => Promise<boolean>;
  remove: () => Promise<void>;
};

function fila(anterior?: Partial<JobFalso>) {
  const add = vi.fn(async () => undefined);
  const remove = vi.fn(async () => undefined);
  const job = anterior
    ? {
        isCompleted: vi.fn(async () => false),
        isFailed: vi.fn(async () => false),
        remove,
        ...anterior,
      }
    : undefined;
  const getJob = vi.fn(async () => job);
  return { fila: { add, getJob } as unknown as Queue<{ x: number }>, add, remove, getJob };
}

const OPCOES = { jobId: 'doc-1-abc', attempts: 3 };

describe('enfileirarLiberandoOId', () => {
  it('enfileira quando não há job com aquele id', async () => {
    const { fila: f, add } = fila();

    await enfileirarLiberandoOId(f, 'estudar', { x: 1 }, OPCOES);

    expect(add).toHaveBeenCalledWith('estudar', { x: 1 }, OPCOES);
  });

  // O id determinístico existe para dois pedidos do mesmo trabalho virarem um.
  it('não duplica o trabalho que ainda está em curso', async () => {
    const { fila: f, add, remove } = fila({});

    await enfileirarLiberandoOId(f, 'estudar', { x: 1 }, OPCOES);

    expect(add).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  // Job encerrado fica guardado por um tempo e a fila recusa, em silêncio, um
  // `add` com id que já existe: era isso que deixava o documento parado e
  // imune a nova tentativa.
  it('tira da frente o job que já terminou, e enfileira', async () => {
    const { fila: f, add, remove } = fila({ isCompleted: vi.fn(async () => true) });

    await enfileirarLiberandoOId(f, 'estudar', { x: 1 }, OPCOES);

    expect(remove).toHaveBeenCalled();
    expect(add).toHaveBeenCalledWith('estudar', { x: 1 }, OPCOES);
  });

  it('tira da frente também o que falhou', async () => {
    const { fila: f, add, remove } = fila({ isFailed: vi.fn(async () => true) });

    await enfileirarLiberandoOId(f, 'estudar', { x: 1 }, OPCOES);

    expect(remove).toHaveBeenCalled();
    expect(add).toHaveBeenCalled();
  });

  it('enfileira direto na fila que não sabe consultar job', async () => {
    const add = vi.fn(async () => undefined);

    await enfileirarLiberandoOId({ add } as unknown as Queue<{ x: number }>, 'estudar', { x: 1 }, OPCOES);

    expect(add).toHaveBeenCalled();
  });
});
