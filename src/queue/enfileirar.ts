import type { JobsOptions, Queue } from 'bullmq';

/**
 * Enfileira liberando o identificador que um job já encerrado esteja ocupando.
 *
 * Os ids desta casa são determinísticos — o par documento + conteúdo —, e é
 * assim de propósito: dois pedidos do mesmo trabalho viram um. O que não
 * estava previsto é que o BullMQ guarda os jobs encerrados por um tempo
 * (`removeOnComplete`, `removeOnFail`) e recusa, **em silêncio**, um `add` com
 * id que já existe. Enquanto o job antigo estava guardado, pedir o mesmo
 * trabalho de novo não enfileirava nada: o documento ficava parado em
 * "estudando" e imune a qualquer nova tentativa.
 *
 * Job ainda em curso ou esperando continua valendo — é para isso que o id
 * existe. Só o que já terminou sai da frente.
 *
 * @param queue a fila. Sem `getJob`, enfileira direto: é o que basta para uma
 *   fila de teste, e em produção o método existe sempre.
 */
export async function enfileirarLiberandoOId<T>(
  queue: Queue<T>,
  nome: string,
  dados: T,
  opcoes: JobsOptions & { jobId: string },
): Promise<void> {
  const fila = queue as unknown as {
    getJob?: (id: string) => Promise<{
      isCompleted: () => Promise<boolean>;
      isFailed: () => Promise<boolean>;
      remove: () => Promise<unknown>;
    } | undefined>;
    add: (nome: string, dados: T, opcoes: JobsOptions) => Promise<unknown>;
  };
  const anterior = await fila.getJob?.(opcoes.jobId);
  if (anterior) {
    const encerrado = (await anterior.isCompleted()) || (await anterior.isFailed());
    if (!encerrado) return;
    await anterior.remove();
  }

  await fila.add(nome, dados, opcoes);
}
