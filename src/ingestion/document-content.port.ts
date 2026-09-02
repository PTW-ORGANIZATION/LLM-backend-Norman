export interface DocumentContent {
  content: Buffer;
  filename: string;
  mimeType: string | null;
}

export interface DocumentContentRequest {
  clientId: string;
  storagePath: string;
  filename: string;
}

/**
 * De onde saem os bytes de um arquivo do repositório do Norman.
 *
 * O LLM-backend não fala com Drive, Supabase nem OneDrive: quem resolve o
 * armazenamento é o Norman, que é o dono do arquivo e da permissão. Esta porta
 * é o contrato que a rota interna dele precisa cumprir (B2 da fila), e é o
 * ponto de troca por uma implementação falsa no teste.
 */
export abstract class DocumentContentPort {
  abstract fetch(request: DocumentContentRequest): Promise<DocumentContent>;
}
