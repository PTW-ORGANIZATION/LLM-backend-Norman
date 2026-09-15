import { Queue } from 'bullmq';
import { clientDossierJobId, studyDocumentJobId } from '../queue/job-id';
import {
  CONSOLIDATE_CLIENT_JOB,
  ConsolidateClientJobData,
  KnowledgeJobData,
  STUDY_DOCUMENT_JOB,
  StudyDocumentJobData,
} from './knowledge-job-data.interface';

/**
 * Enfileira o estudo de um documento já vetorizado.
 *
 * O `jobId` é o par documento + conteúdo: reenviar o mesmo arquivo reaproveita
 * o job que já está na fila em vez de estudar duas vezes.
 *
 * `removeOnFail: true` pelo mesmo motivo que a consolidação: job guardado
 * mantém o id ocupado, e a fila ignora em silêncio um `add` com id que já
 * existe. Enquanto o job que falhou ficava guardado, reprocessar o documento
 * não enfileirava nada — o arquivo ficava parado em "estudando" e imune a
 * nova tentativa. O motivo da falha não se perde: ele vai para o documento.
 */
export async function enqueueDocumentStudy(
  queue: Queue<KnowledgeJobData>,
  data: StudyDocumentJobData,
): Promise<void> {
  await queue.add(STUDY_DOCUMENT_JOB, data, {
    jobId: studyDocumentJobId(data.documentId, data.sha256),
    attempts: 3,
    backoff: { type: 'exponential', delay: 15000 },
    removeOnComplete: 1000,
    removeOnFail: true,
  });
}

/**
 * Enfileira a consolidação do dossiê de um cliente, com atraso e id fixo.
 *
 * O id fixo é o que transforma uma rajada de cinquenta arquivos num dossiê só:
 * enquanto o job estiver esperando, um segundo `add` com o mesmo id não cria
 * outro. `removeOnComplete: true` é obrigatório junto disso — job completo que
 * fica guardado mantém o id ocupado, e a próxima mudança do acervo nunca
 * enfileiraria.
 */
export async function enqueueClientConsolidation(
  queue: Queue<KnowledgeJobData>,
  clientId: string,
  delayMs: number,
): Promise<void> {
  const data: ConsolidateClientJobData = { clientId };

  await queue.add(CONSOLIDATE_CLIENT_JOB, data, {
    jobId: clientDossierJobId(clientId),
    delay: delayMs,
    attempts: 3,
    backoff: { type: 'exponential', delay: 30000 },
    removeOnComplete: true,
    removeOnFail: true,
  });
}
