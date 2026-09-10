export interface DocumentContent {
  content: Buffer;
  filename: string;
  mimeType: string | null;
}

export interface DocumentContentRequest {
  /**
   * O nível do acervo do arquivo pedido.
   *
   * Vai junto porque o Norman confere a propriedade antes de ler byte nenhum:
   * caminho de cliente é conferido contra o cliente informado, e caminho do
   * acervo geral é conferido contra o destino canônico do sistema. Sem o nível,
   * um pedido sem cliente não teria contra o que ser conferido.
   */
  scope: 'system' | 'client';
  clientId: string | null;
  storagePath: string;
  filename: string;
  expectedSha256: string | null;
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
