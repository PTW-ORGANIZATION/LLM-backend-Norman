/**
 * Os níveis de acervo que o banco reconhece.
 *
 * `person` é o conhecimento que um usuário subiu para si, isolado por
 * organização. `client` é o acervo privado de um cliente. `system` é o
 * conhecimento geral do Norman: sem dono cliente, administrado uma vez e
 * compartilhado nas gerações vinculadas a cliente.
 *
 * O nível é um discriminador **persistido**. Ele não é deduzido de `clientId`
 * ausente, de pasta chamada "geral" nem do caminho do arquivo: a ausência
 * acidental de um campo passaria a significar "compartilhe com todos", que é o
 * contrário do lado seguro.
 */
export const KNOWLEDGE_SCOPES = ['system', 'client', 'person'] as const;

export type KnowledgeScopeKind = (typeof KNOWLEDGE_SCOPES)[number];

/**
 * Os níveis que a ingestão vinda do Norman pode gravar.
 *
 * `person` fica fora: aquelas linhas nascem do chat de pessoa deste backend, e
 * o contrato interno de ingestão não as produz.
 */
export const INGESTION_SCOPES = ['system', 'client'] as const;

export type IngestionScope = (typeof INGESTION_SCOPES)[number];

export const SYSTEM_SCOPE: IngestionScope = 'system';
export const CLIENT_SCOPE: IngestionScope = 'client';

export function isIngestionScope(value: unknown): value is IngestionScope {
  return typeof value === 'string' && (INGESTION_SCOPES as readonly string[]).includes(value);
}

/**
 * O que está errado no par nível + dono, ou nulo quando o par é válido.
 *
 * Para `client`, o `clientId` é obrigatório — é ele a trava de isolamento. Para
 * `system`, ele precisa estar **ausente**: aceitar um cliente numa linha
 * compartilhada faria a mesma fonte pertencer a um dono e a todos ao mesmo
 * tempo, e nenhuma consulta conseguiria decidir qual das duas coisas ela é.
 */
export function scopeOwnershipProblem(input: {
  scope: IngestionScope;
  clientId?: string | null;
}): string | null {
  const clientId = String(input.clientId || '').trim();

  if (input.scope === CLIENT_SCOPE) {
    return clientId ? null : 'o acervo de cliente exige clientId';
  }

  if (input.scope === SYSTEM_SCOPE) {
    return clientId ? 'o acervo geral do sistema não pertence a nenhum cliente' : null;
  }

  return `nível de acervo "${String(input.scope)}" não é aceito nesta operação`;
}
