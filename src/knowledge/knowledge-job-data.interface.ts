export const STUDY_DOCUMENT_JOB = 'study-document';
export const CONSOLIDATE_CLIENT_JOB = 'consolidate-client';

// Shape do payload enfileirado em `knowledge-jobs`. Só um tipo (sem decorators),
// pelo mesmo motivo de IngestionJobData: importar isso de outro módulo não cria
// dependência circular no grafo de módulos do Nest.
export interface StudyDocumentJobData {
  documentId: string;
  /** O nível do acervo. Ausente vale `client`, nunca `system`. */
  knowledgeScope?: 'system' | 'client';
  clientId: string | null;
  scopePath: string;
  filename: string;
  sha256: string;
}

export interface ConsolidateClientJobData {
  clientId: string;
}

export type KnowledgeJobData = StudyDocumentJobData | ConsolidateClientJobData;
