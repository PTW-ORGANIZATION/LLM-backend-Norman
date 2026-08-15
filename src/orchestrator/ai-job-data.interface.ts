// Shape do payload enfileirado pelo ConversationsController e consumido pelo
// AiJobProcessor. Só um tipo (sem decorators) — importar isso de outro módulo
// não cria dependência circular no grafo de módulos do Nest.
export interface AiJobData {
  conversationId: string;
  userId: string;
  organizationId: string | null;
}
