/**
 * Identificadores de job das filas de conhecimento.
 *
 * O BullMQ recusa `jobId` que contenha `:` — ele usa esse caractere para separar
 * as chaves dele no Redis, e quem passa um id com dois-pontos toma
 * `Custom Id cannot contain :` na hora do `add`. Os ids nascem aqui, e não
 * espalhados por quem enfileira, para que a regra valha nos três casos de uma
 * vez.
 *
 * Os ids são determinísticos de propósito: reenviar o mesmo conteúdo reaproveita
 * o job em vez de duplicar trabalho.
 */

const SEPARADOR = '-';

function assertJobId(id: string): string {
  if (id.includes(':')) {
    throw new Error(`jobId não pode conter ":" (BullMQ recusa): ${id}`);
  }
  return id;
}

export function ingestDocumentJobId(documentId: string, sha256: string): string {
  return assertJobId(['ingest', documentId, sha256].join(SEPARADOR));
}

export function studyDocumentJobId(documentId: string, sha256: string): string {
  return assertJobId(['study', documentId, sha256].join(SEPARADOR));
}

export function clientDossierJobId(clientId: string): string {
  return assertJobId(['dossier', clientId].join(SEPARADOR));
}
