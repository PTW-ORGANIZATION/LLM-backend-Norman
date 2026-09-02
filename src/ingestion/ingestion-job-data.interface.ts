// Shape do payload enfileirado em `ingestion-jobs`. Só um tipo (sem
// decorators), pelo mesmo motivo de AiJobData: importar isso de outro módulo não
// cria dependência circular no grafo de módulos do Nest.
export interface IngestionJobData {
  documentId: string;
  clientId: string;
  scopePath: string;
  storagePath: string;
  filename: string;
  sha256: string;
}
