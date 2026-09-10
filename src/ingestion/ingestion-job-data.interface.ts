// Shape do payload enfileirado em `ingestion-jobs`. Só um tipo (sem
// decorators), pelo mesmo motivo de AiJobData: importar isso de outro módulo não
// cria dependência circular no grafo de módulos do Nest.
export interface IngestionJobData {
  documentId: string;
  /**
   * O nível do acervo do documento.
   *
   * Opcional só para não invalidar job já enfileirado quando esta versão sobe;
   * ausente vale `client`, que é o nível estreito. Nunca vale `system` por
   * omissão — omissão não compartilha nada.
   */
  knowledgeScope?: 'system' | 'client';
  clientId: string | null;
  scopePath: string;
  storagePath: string;
  filename: string;
  sha256: string;
}
