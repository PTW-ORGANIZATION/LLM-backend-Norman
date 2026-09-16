# Correção final — recuperação durável entre publicação, fonte e ingestão

**Data:** 09/09/2026  
**Origem:** auditoria independente do HEAD `9375fcd9ce05ffb5fb946c2cdb6d26df837e601e` no LLM-backend e `63b1e06f4269418da2a8eeaba06e14cbc20a4cc8` no Norman  
**Publicação:** não fazer push, deploy, migration remota ou backfill

## 1. Resultado da rodada

As correções de objeto estável, geração autoritativa, conferência de hash e recuperação de anúncio `cancelled` existem no código real e passaram nas suítes. Ainda faltam garantias de recuperação entre as transações do índice de arquivos, da fonte administrada e da ingestão no executor.

O defeito restante não está no CAS do Google Drive. Ele está no evento que conecta `storage_confirmed` a `knowledge_sources` e ao LLM-backend: hoje esse evento é um callback em memória, e não um estado durável retomável.

## 2. P0 — queda entre staging e criação da fonte deixa publicação sem dona

### Evidência

Em `server/modules/ai-knowledge/ai-knowledge.service.ts`, `storeAndRegisterDocument` executa em sequência:

1. `storeSystemKnowledgeFile` ou `storeGeneralKnowledgeFile`, que cria e confirma a linha de staging em `asset_file_index`;
2. `registerDocumentAt`, que cria/substitui a linha em `knowledge_sources` numa transação separada.

O retorno do storage contém `publication.generation`, mas essa geração não é gravada em `knowledge_sources` e não existe uma tabela durável ligando a publicação à fonte esperada.

Se o processo cair depois do passo 1 e antes do passo 2:

- o processador publica normalmente a geração no Drive;
- `asset_file_index` chega a `storage_confirmed`;
- no acervo geral não existe a nova fonte correspondente;
- o callback `publishConfirmedAtPath` procura por caminho, encontra nenhuma fonte ou a fonte anterior com outro hash e devolve `absent`/`stale`;
- a publicação já confirmada não volta à fila;
- não existe reconciliação posterior que crie a fonte ausente;
- se havia uma fonte anterior, ela continua vigente, mas a leitura com o hash antigo passa a receber `CONTENT_SUPERSEDED`.

Isso viola a exigência de sobreviver a queda e de manter publicação, hash, fonte vigente e bytes na mesma geração.

### Correção exigida

Criar uma ligação durável entre a intenção administrativa e a publicação. Opções aceitáveis:

- persistir `publication_id` e `publication_generation` em `knowledge_sources`, com estado de publicação explícito; ou
- criar uma outbox própria que contenha nível, dono, caminho, hash, publicação e operação esperada.

O worker precisa conseguir reconstruir o passo ausente após reinício, sem depender da requisição HTTP original nem de callback em memória. A operação deve ser idempotente e protegida por CAS.

Testar quedas em todos estes pontos:

- depois do staging e antes de criar a fonte;
- depois de criar a fonte e antes de confirmar o storage;
- depois de confirmar o storage e antes de disparar a ingestão;
- depois do efeito externo no LLM-backend e antes do ack local.

## 3. P0 — confirmação do storage perde a ingestão de cliente quando o observador falha

### Evidência

`markRepositoryFileSynced` grava `storage_confirmed` no banco e somente depois chama `notifyAwaited(observer.onFileIndexed, ...)`.

`notifyAwaited` captura a exceção, registra warning e a descarta. Como a linha já está `storage_confirmed`, ela não é selecionada novamente por `getRunnableRepositoryFileRecords`.

Para fonte geral existe a caixa de saída de `announceState`, que consegue retomar o anúncio. Para fonte de cliente não existe estado durável equivalente.

No callback de produção, `knowledge.rememberRepositoryFile(file)` roda antes de `aiKnowledge.publishConfirmedAtPath`. Se a primeira chamada ao LLM-backend falhar:

- o restante do callback não executa;
- a fonte administrativa do cliente permanece em `status: "studying"`;
- ela não é marcada como `failed`;
- o botão de retry não aparece;
- a publicação não volta à fila;
- reiniciar o processo não repete o callback perdido.

O teste atual chamado “a falha do observador não derruba a confirmação da publicação” comprova apenas que o storage fica confirmado. Ele não comprova que a ingestão perdida é retomada.

### Correção exigida

Substituir o callback como mecanismo de entrega por uma outbox/estado durável. O callback pode acordar o worker, mas não pode ser a única cópia da obrigação.

Para cliente e sistema, a conclusão precisa distinguir pelo menos:

- storage confirmado;
- registro da fonte confirmado;
- ingestão solicitada;
- ingestão confirmada ou falha recuperável.

Uma falha transitória deve deixar estado executável pelo worker depois de reinício. A interface deve mostrar falha/retentativa real em vez de uma fonte presa em `studying`.

## 4. P1 — gerações superadas deixam staging órfão e podem perder o ID estável

### Evidência

`createRepositoryFileRecord` apaga todas as linhas anteriores do mesmo caminho antes de inserir a nova.

- Se A e B forem staged antes de o worker processar A, a linha A é apagada, mas `local_temp_path` de A não é removido.
- Nenhum worker encontra a linha apagada para limpar os bytes temporários.
- O estado `superseded` criado pela migration não é usado no fluxo normal; aparece apenas na migração de dados antigos.

Além disso, o novo registro copia apenas `drive_item_id` da linha anterior. Se a linha anterior ainda estiver staged e carregar o objeto estável em `previous_drive_item_id`, uma terceira substituição antes do processamento perde essa identidade. A busca por nome pode mascarar o defeito, mas não substitui a identidade estável já conhecida.

### Correção exigida

- Não apagar silenciosamente a obrigação de cleanup.
- Marcar a geração antiga como `superseded` e limpá-la por worker, ou remover seus bytes temporários com confirmação idempotente.
- Preservar a cadeia `drive_item_id ?? previous_drive_item_id` ao criar a próxima geração.
- Garantir que cleanup atrasado nunca apague o staging da geração vigente.

Testar A→B→C sem processar A ou B, incluindo staging inteiro e chunked.

## 5. P2 — caminho administrativo de cliente faz duas chamadas de registro

No observador de produção, uma publicação confirmada de cliente passa primeiro por `rememberRepositoryFile`, com origem `repository_sync`, e depois por `publishConfirmedAtPath`, que usa origem `administrative`.

Os testes de `announcement-publication.integration.test.ts` não reproduzem o callback real: eles chamam apenas `publishConfirmedAtPath` e omitem `rememberRepositoryFile`.

O resultado pode ser duas chamadas HTTP para o mesmo documento. Em reenvio que precisa levantar lápide, a primeira é recusada e a segunda levanta a lápide. Funciona, mas adiciona efeito, fila e estados intermediários desnecessários.

O callback real deve escolher uma única origem com base na intenção durável da publicação. Upload administrativo deve produzir apenas registro administrativo; varredura comum deve produzir apenas `repository_sync`.

## 6. Evidências já validadas e que não devem ser desfeitas

- Um commit humano após cada base.
- Hashes auditados: LLM-backend `9375fcd9ce05ffb5fb946c2cdb6d26df837e601e`; Norman `63b1e06f4269418da2a8eeaba06e14cbc20a4cc8`.
- LLM-backend: typecheck, build, 815 testes e 82 contratos passaram.
- Norman: check, check:server, build e 11.571 testes passaram.
- Cobertura independente do Norman: statements 99,08%; branches 93,61%; functions 98,69%; lines 99,63%.
- A recuperação `cancelled → pending` usa CAS, reconfere lápide e chega ao claim normal.
- A ingestão confere o SHA-256 pedido contra os bytes recebidos.
- `NORMAN_AI_FORCE_CONNECTION` continua baseado em ativação real; `forced:` existe apenas em comentários históricos.
- Nenhum segredo plausível ou referência a assistente apareceu nos diffs ou mensagens de commit.
- A chave privada presente no teste novo é a mesma chave dummy já versionada nos outros testes do Google Drive.

## 7. Restrições

- Preservar todos os arquivos não rastreados.
- Não usar credenciais compartilhadas anteriormente.
- Não fazer push, deploy, migration remota ou backfill.
- Não adicionar comentários de código, JSDoc, TODO ou FIXME.
- Não alterar autorização, ativação em duas fases, fallback fixado, isolamento, áudio, formatos legados, streaming ou cancelamento.
- Manter exatamente um commit humano depois de cada base.

## 8. Prompt para o Claude

Leia integralmente:

`/Users/diego.alipio/ptw/LLM-backend-Norman/HANDOFF_CODEX_AUDITORIA_MULTIPROVEDOR_2026-09-09.md`

`/Users/diego.alipio/ptw/LLM-backend-Norman/CORRECAO_FINAL_RECUPERACAO_DURAVEL_PUBLICACAO_2026-09-09.md`

Inspecione o código real nos dois repositórios e corrija os quatro pontos descritos no documento, com prioridade para as duas perdas duráveis P0.

A publicação precisa sobreviver a reinício em todas as fronteiras entre staging, `asset_file_index`, `knowledge_sources`, Google Drive e LLM-backend. Não use callback em memória como única entrega de uma obrigação. Persista a identidade/generação da publicação ou uma outbox equivalente e faça o worker retomar cada etapa por CAS e idempotência.

Garanta também cleanup idempotente de gerações superadas, preservação de `previous_drive_item_id` através de A→B→C e uma única origem/chamada de registro para upload administrativo de cliente.

Antes da implementação, escreva testes que falhem no HEAD atual para:

1. queda depois do staging e antes da criação da fonte geral;
2. queda depois de `storage_confirmed` e antes do callback de ingestão de cliente;
3. callback do LLM-backend falhando uma vez e recuperação automática após reinício;
4. A→B→C staged sem processamento, sem staging órfão e preservando o objeto estável;
5. callback real de produção fazendo uma única chamada administrativa para cliente;
6. efeito externo concluído e ack local perdido, sem duplicar registro nem ingestão.

Depois rode typecheck/check, builds, suítes completas, cobertura, migrations up/down/up, contratos HTTP cruzados e as regressões de autorização, ativação, `NORMAN_AI_FORCE_CONNECTION`, fallback, isolamento, áudio, formatos legados, streaming e cancelamento.

Use PostgreSQL de servidor para concorrência entre sessões quando `NORMAN_IT_DATABASE_URL` estiver disponível. Sem a variável, pule explicitamente e não atribua essa prova ao PGlite.

Preserve os arquivos não rastreados e as correções já validadas. Não adicione comentários de código ou JSDoc. Não use credenciais anteriores. Não faça push, deploy, migration remota ou backfill.

Ao final, deixe exatamente um commit humano depois de `aded5b945f87e8b1ccdeb72abb7c835fc307093e` no LLM-backend e depois de `2af225aac88a2312e798fc0719587c403fa6d50a` no Norman. Informe hashes, testes exatos, cobertura, migrations, pulos e evidências das quedas/reinícios. Pare sem publicar e aguarde nova auditoria independente.
