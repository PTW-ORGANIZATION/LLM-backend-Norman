# Correção final — sincronização autoritativa do storage e recuperação de anúncio cancelado

**Data:** 09/09/2026  
**Situação:** auditoria independente após a entrega do Claude  
**Publicação:** proibidos push, deploy, migration remota e backfill até autorização explícita

## 1. Veredito da auditoria

A entrega corrigiu os itens anteriores de origem administrativa, rearme por compare-and-set, unicidade da fonte vigente por caminho e índice do outbox. As suítes completas dos dois repositórios passaram.

Ainda existe um bloqueador de consistência no fluxo real de armazenamento. A serialização adicionada em `withUploadSlot` protege apenas o período em que o Norman cria a entrada temporária e decide qual `knowledge_source` fica vigente. Os bytes são enviados ao Google Drive depois, pelo processador assíncrono, quando a trava já foi liberada.

Portanto, a garantia declarada de que o caminho final contém os bytes correspondentes ao hash da fonte vigente ainda não existe.

## 2. P0 — o caminho, o hash e os bytes definitivos não formam uma publicação atômica

### Evidências no código real

1. `server/modules/knowledge/knowledge.service.ts`, em `storeGeneralKnowledgeFile` e `storeSystemKnowledgeFile`, chama `stageRepositoryUpload` e retorna `stored: true` imediatamente após criar o staging.
2. `server/modules/assets/repository-upload.service.ts`, em `stageRepositoryFileUpload`, cria uma linha nova em `asset_file_index` para cada envio, com `syncStatus: "syncing"` e um caminho temporário distinto.
3. `server/asset-file-index.ts`, em `createRepositoryFileRecord`, não torna `repository_path` único, não marca uma geração autoritativa e não invalida/supersede filas anteriores do mesmo caminho.
4. `server/modules/ai-knowledge/ai-knowledge.service.ts`, em `storeAndRegisterDocument`, registra a fonte e, no nível `system`, pode anunciá-la ao executor antes de o arquivo definitivo estar sincronizado.
5. `server/modules/assets/repository-sync.processor.ts` busca e processa todas as linhas executáveis. Antes do upload, não confirma se aquela linha ainda corresponde à fonte vigente e ao hash vencedor do caminho.
6. `server/google-drive.ts` implementa o upload com `POST .../files` e metadados de criação. Para Google Drive, `conflictBehavior: "fail"` apenas evita o renomeio local; ele não faz uma operação de substituição nem impede nomes duplicados.
7. O índice único da migration `0027` atua em `knowledge_sources`, não em `asset_file_index` nem na identidade do objeto externo.

### Cenário que ainda falha conceitualmente

Dois envios com bytes diferentes usam o mesmo nível, dono e nome:

1. A entra na trava, cria staging A e fonte A, e libera a trava.
2. B entra depois, cria staging B, substitui a fonte vigente por B e libera a trava.
3. O processador ainda pode enviar A e B ao Drive, inclusive fora de ordem quando houver mais de um worker.
4. O Drive pode manter dois objetos com o mesmo nome.
5. A resolução posterior por caminho pode encontrar bytes A, enquanto `knowledge_sources.sha256` declara B.

Os testes concorrentes atuais usam armazenamento falso síncrono em memória. Eles provam a decisão de fonte vigente, mas não atravessam o staging real, a fila, o processador e um adapter com semântica de criação equivalente à do Google Drive.

### Resultado obrigatório

Após qualquer ordem de concorrência, retry, queda ou retomada, deve existir uma única versão autoritativa para o caminho lógico. A fonte vigente, o hash registrado e os bytes efetivamente resolvidos para ingestão precisam corresponder à mesma geração.

### Direção de implementação

A solução pode variar, mas precisa tornar explícita a identidade/generação autoritativa. Exemplos aceitáveis:

- criar uma geração monotônica ou identificador de publicação por caminho lógico;
- substituir/superseder atomicamente filas antigas quando uma geração nova vence;
- fazer o processador reivindicar e publicar apenas a geração ainda autoritativa;
- impedir que um job antigo conclua ou volte a aparecer depois que uma geração nova venceu;
- usar identidade imutável/content-addressed no caminho físico e apontar a fonte para esse objeto exato; ou
- fazer upsert/substituição por ID estável no Drive com compare-and-set verificável.

O anúncio/ingestão no LLM-backend não pode ser confirmado antes de o storage confirmar a publicação da geração correta. Se a arquitetura mantiver duas fases, o estado deve representar claramente `staged`, `storage_confirmed` e `ingestion_confirmed`, com retomada idempotente.

Não basta adicionar outro mutex em memória, alongar o advisory lock até um job assíncrono ou confiar na ordem de criação do Drive.

### Testes obrigatórios

- integração atravessando serviço de conhecimento, staging, índice e processador;
- dois conteúdos diferentes no mesmo caminho, com workers concluindo A→B e B→A;
- exatamente um objeto autoritativo e resolúvel ao final;
- hash da fonte vigente igual ao hash dos bytes baixados pelo caminho/ID usado na ingestão;
- job antigo não pode sobrescrever, ressuscitar ou tornar ambígua a versão vencedora;
- queda depois do upload externo e antes do commit local;
- retry idempotente sem criar duplicata externa;
- anúncio ao executor somente após confirmação do storage;
- duas réplicas com PostgreSQL de servidor quando `NORMAN_IT_DATABASE_URL` estiver disponível; o teste deve pular explicitamente sem essa variável, sem alegar que PGlite prova concorrência entre sessões.

## 3. P1 — fonte geral vigente em `cancelled` não possui recuperação utilizável

Quando uma lápide ancestral recusa o anúncio, a fonte geral pode permanecer vigente com `announceState: "cancelled"`.

Hoje:

- `announcementMissing` reconhece apenas estado nulo;
- `retrySourceAt` anuncia apenas `pending`, `failed` ou nulo;
- uma fonte `cancelled` e sem `status: "failed"` recebe `SOURCE_NOT_FAILED`;
- reenvio dos mesmos bytes encontra a fonte vigente por conteúdo e devolve a mesma fonte cancelada;
- a interface corretamente deixou de prometer um botão inexistente, mas não oferece um caminho de recuperação depois que a lápide ancestral deixa de existir.

É necessário escolher e implementar um fluxo determinístico. Preferência: retry administrativo explícito que, depois de conferir novamente a lápide, faça CAS de `cancelled` para `pending` somente na fonte geral ainda vigente e então use o claim normal. Alternativamente, documentar e implementar remoção + reenvio como operação única segura. Um simples reenvio idêntico não pode continuar preso para sempre no estado cancelado.

Testes obrigatórios:

- retry enquanto a lápide ainda existe permanece recusado, sem chamada externa;
- depois da remoção da lápide, retry da fonte vigente cancelada chega a `confirmed`;
- resposta atrasada de versão antiga não reabre anúncio;
- duas réplicas tentando recuperar fazem uma única chamada externa;
- interface expõe a ação somente quando ela é realmente executável.

## 4. Correção pequena já aplicada pelo Codex

Foi reproduzido um deadlock por esgotamento do pool: com `max` uploads diferentes, cada callback segurava uma conexão para o advisory lock e esperava outra conexão do mesmo pool. O Norman agora limita os slots simultâneos de upload a `pool.max - 1`, preservando uma conexão para o corpo da operação.

Arquivos alterados:

- `server/modules/ai-knowledge/ai-knowledge.repository.ts`;
- `server/modules/ai-knowledge/knowledge-source-path.integration.test.ts`.

Novo HEAD local do Norman: `33a8a1158b571497d0b840ec4344e6452ee77cc0`, ainda exatamente um commit após a base `2af225aac88a2312e798fc0719587c403fa6d50a`.

Validação após a correção:

- `check`, `check:server` e `build`: passaram;
- suíte: 458 arquivos passaram, 1 ignorado; 11.490 testes passaram, 4 ignorados;
- cobertura: statements 99,09%; branches 93,64%; functions 98,72%; lines 99,62%.

Não reverta nem duplique essa correção.

## 5. Restrições

- Ler integralmente os handoffs e este documento antes de alterar código.
- Preservar todos os arquivos não rastreados.
- Não usar credenciais previamente compartilhadas.
- Não fazer push, deploy, migration remota ou backfill.
- Não adicionar comentários de código, JSDoc, TODO ou FIXME.
- Não alterar decisões já validadas de autorização, ativação em duas fases, fallback fixado, isolamento, áudio, formatos legados, streaming ou cancelamento.
- Manter exatamente um commit humano depois de cada base.
- Procurar segredos e referências a assistentes no diff e nas mensagens de commit.

## 6. Prompt completo para a próxima rodada do Claude

Leia integralmente, antes de responder:

`/Users/diego.alipio/ptw/LLM-backend-Norman/HANDOFF_CODEX_AUDITORIA_MULTIPROVEDOR_2026-09-09.md`

`/Users/diego.alipio/ptw/LLM-backend-Norman/CORRECAO_FINAL_SINCRONIZACAO_AUTORITATIVA_STORAGE_2026-09-09.md`

Depois inspecione o código real nos dois repositórios. Não confie nos relatórios anteriores.

Corrija os dois itens pendentes:

1. torne autoritativa e verificável a publicação de cada caminho lógico através de staging, fila, storage externo, `knowledge_sources` e anúncio/ingestão, impedindo que jobs antigos ou uploads concorrentes produzam ambiguidade, duplicata externa ou divergência entre hash e bytes;
2. implemente recuperação determinística e segura de uma fonte geral vigente em `announceState: "cancelled"` após a lápide deixar de bloqueá-la.

A solução deve sobreviver a concorrência, múltiplos workers, conclusão fora de ordem, retry e queda entre o efeito externo e o commit local. Não aceite mutex em memória como prova distribuída e não trate o `conflictBehavior: "fail"` do adapter do Google Drive como garantia de unicidade: confira a implementação real.

Antes de implementar, escreva testes que reproduzam as falhas. Depois, implemente a correção e rode:

- typecheck/check dos dois repositórios;
- builds;
- suítes completas;
- cobertura com os pisos existentes;
- contracts HTTP cruzados;
- migrations up/down/up em bancos descartáveis;
- testes de concorrência com PostgreSQL de servidor quando a variável de integração estiver disponível;
- regressões de autorização, ativação em duas fases, `NORMAN_AI_FORCE_CONNECTION`, fallback fixado, isolamento, áudio, formatos legados, streaming e cancelamento.

Valide que o token do Norman continua autorizado para todas as operações que o adapter realmente produz e que outros consumidores continuam restritos. A ativação forçada deve continuar dependendo de uma ativação real, confirmada e determinística; nunca aceite `forced:<chave>`.

Preserve a correção pequena já aplicada pelo Codex no HEAD `33a8a1158b571497d0b840ec4344e6452ee77cc0`. Preserve os arquivos não rastreados. Não adicione comentários de código ou JSDoc. Não use credenciais compartilhadas anteriormente. Não faça push, deploy, migration remota nem backfill.

Ao final:

- deixe exatamente um commit humano após `aded5b945f87e8b1ccdeb72abb7c835fc307093e` no LLM-backend;
- deixe exatamente um commit humano após `2af225aac88a2312e798fc0719587c403fa6d50a` no Norman;
- informe hashes, arquivos alterados, testes exatos, cobertura, migrations, testes pulados e motivos;
- mostre evidência específica dos cenários concorrentes e de recuperação de `cancelled`;
- pare sem publicar nada e aguarde nova auditoria independente do Codex.
