import { describe, expect, it, vi } from 'vitest';
import { enqueueClientConsolidation, enqueueDocumentStudy } from './knowledge-queue';

/**
 * Reproduz a recusa do BullMQ (`Custom Id cannot contain :`, em
 * `classes/job.js`). A fila estava mockada sem essa checagem em todo teste, e
 * foi por isso que três `jobId` inválidos chegaram ao ambiente de
 * desenvolvimento sem nenhum teste vermelho.
 */
function filaQueValida() {
  const add = vi.fn(async (_nome: string, _dados: unknown, opts: { jobId?: string }) => {
    const id = opts?.jobId;
    if (typeof id === 'string' && id.includes(':') && id.split(':').length !== 3) {
      throw new Error('Custom Id cannot contain :');
    }
    return { id };
  });
  return { add } as any;
}

describe('enfileiramento do conhecimento', () => {
  const DADOS = { documentId: 'doc-1', clientId: 'cli-1', sha256: 'a'.repeat(64) } as any;

  it('o estudo de documento é aceito pela fila', async () => {
    const fila = filaQueValida();
    await expect(enqueueDocumentStudy(fila, DADOS)).resolves.toBeUndefined();
    expect(fila.add.mock.calls[0][2].jobId).not.toContain(':');
  });

  it('a consolidação do dossiê é aceita pela fila', async () => {
    const fila = filaQueValida();
    await expect(enqueueClientConsolidation(fila, 'cli-1', 5000)).resolves.toBeUndefined();
    expect(fila.add.mock.calls[0][2].jobId).not.toContain(':');
  });

  it('o dossiê mantém id fixo e atraso, que é o que junta a rajada num job só', async () => {
    const fila = filaQueValida();
    await enqueueClientConsolidation(fila, 'cli-1', 5000);
    await enqueueClientConsolidation(fila, 'cli-1', 5000);
    const [primeiro, segundo] = fila.add.mock.calls.map((c: any) => c[2]);
    expect(primeiro.jobId).toBe(segundo.jobId);
    expect(primeiro.delay).toBe(5000);
    expect(primeiro.removeOnComplete).toBe(true);
  });

  it('a fila falsa realmente pegaria o defeito antigo', async () => {
    const fila = filaQueValida();
    await expect(fila.add('x', {}, { jobId: 'doc-1:abc' })).rejects.toThrow(/Custom Id/);
  });
});
