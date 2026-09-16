# Correção final: segurança, durabilidade e independência do RAG de sistema

Data da auditoria: 2026-09-09

Resultado: **Ainda não pronto**

Este documento é um plano corretivo. Ele não autoriza push, deploy, migration remota, backfill, uso de credenciais reais ou alteração de ambientes externos.

## 1. Estado auditado

### LLM-backend

- Repositório: `/Users/diego.alipio/ptw/LLM-backend-Norman`
- Branch: `feature/formatos-legados-doc-xls-pptx`
- Base preservada: `aded5b945f87e8b1ccdeb72abb7c835fc307093e`
- HEAD auditado: `4cddd9ad209690e88f96b41fe4e810057703bb38`
- Distância da base: exatamente 1 commit
- `git diff --check`: limpo

### Norman

- Repositório: `/Users/diego.alipio/ptw/Norman`
- Branch: `feature/finalizacao-camada-conhecimento`
- Base preservada: `2af225aac88a2312e798fc0719587c403fa6d50a`
- HEAD auditado: `643abd900c6f406a3daeeb73a0da4f6d10402e91`
- Distância da base: exatamente 1 commit
- `git diff --check`: limpo

### Validações que passaram

- LLM-backend: typecheck, build, 760 testes aprovados, 16 ignorados e 30 testes de contrato aprovados.
- Norman: checks TypeScript, build, 11.365 testes aprovados, 4 ignorados e cobertura de 99,08% statements, 93,67% branches, 98,67% functions e 99,62% lines.
- Os arquivos de planejamento e handoff não rastreados foram preservados.
- A varredura das linhas adicionadas não encontrou segredo aparente nem referência a Claude, Codex, ChatGPT ou outro assistente.
- `NORMAN_AI_FORCE_CONNECTION` resolve uma ativação persistida e confirmada pelo executor. A implementação não fabrica `forced:<chave>`.

Suítes verdes não eliminam os defeitos abaixo: alguns cenários não existem nos testes e outros testes consolidam o comportamento defeituoso como esperado.

## 2. Bloqueadores objetivos

### P0 — Qualquer consumidor interno autenticado pode administrar ou consultar todo o conhecimento

No LLM-backend, `InternalAuthGuard` aceita tanto o token do Norman quanto qualquer token válido de `INTERNAL_CONSUMERS` e coloca a aplicação em `request.consumer`.

O controller de geração usa essa identidade para restringir operações e escopos. Os controllers abaixo, porém, usam somente o guard e não autorizam a operação com base no consumidor:

- `src/ingestion/internal-documents.controller.ts`
- `src/ingestion/internal-knowledge.controller.ts`

Consequência: um consumidor configurado apenas para uma operação de geração pessoal pode, com seu próprio token válido:

- registrar documento com qualquer `clientId`;
- registrar documento com `scope: "system"` e injetar conhecimento em todos os clientes;
- pesquisar o acervo de qualquer cliente ou o acervo geral;
- consultar status por ID, visão geral, dossiê e estado de ingestão;
- revogar, renomear ou reprocessar documentos de cliente ou do sistema;
- solicitar regeneração de dossiê de qualquer cliente;
- usar a extração documental interna fora da autorização declarada.

Isto viola a regra obrigatória de que o token do Norman deve executar as operações produzidas por seus adapters e os demais consumidores devem continuar restritos.

#### Correção obrigatória

1. Criar autorização explícita por capacidade para rotas internas, separada da lista de operações de geração.
2. Definir capacidades mínimas e fechadas, cobrindo leitura e escrita de conhecimento de cliente, leitura e escrita de conhecimento do sistema, extração documental e administração de conexões.
3. Dar ao consumidor `norman` exatamente as capacidades exigidas pelos adapters reais do Norman.
4. Não conceder capacidades de conhecimento ou de conexão a consumidores de `INTERNAL_CONSUMERS` por omissão.
5. Conferir a capacidade em todas as rotas de `InternalDocumentsController`, `InternalKnowledgeController` e nas rotas administrativas de conexão.
6. No `GET /internal/documents/:id`, autorizar também o nível e o dono do documento encontrado; conhecer um UUID não pode contornar o escopo.
7. Falhar com 403 antes de qualquer chamada a banco, fila, embedding, extração ou armazenamento.
8. Manter comparação de tokens em tempo constante e o fechamento por padrão.

Uma checagem baseada apenas em `consumer.name === "norman"` fecha o vazamento imediato, mas uma matriz explícita de capacidades é preferível porque torna auditável cada porta interna e evita nova abertura acidental.

#### Testes obrigatórios

- HTTP real: token do Norman executa todas as operações emitidas pelos adapters do Norman.
- HTTP real: token de um consumidor com apenas `chat:person` recebe 403 em cada rota de documentos e conhecimento.
- HTTP real: esse consumidor recebe 403 ao tentar `scope: "system"` e ao tentar `clientId` arbitrário.
- HTTP real: nenhum mock de serviço, banco, fila, embedding ou extração é chamado após o 403.
- HTTP real: as operações de geração ainda obedecem à allowlist e aos escopos existentes.
- Teste de inventário: toda rota interna sensível tem uma capacidade declarada e toda operação usada pelos adapters do Norman aparece na matriz do Norman.

### P0 — Falha ao anunciar fonte geral ao LLM-backend deixa a fonte presa indefinidamente

No Norman, `announceSystemFile` retorna sem erro quando `registerSystemDocument` não existe e captura qualquer falha de rede apenas com `console.warn`.

Os fluxos de documento, texto e transcrição de áudio aguardam essa função e mesmo assim devolvem aceitação ou publicação. A fonte fica normalmente em `studying`, porém:

- a varredura do repositório ignora de propósito a raiz de conhecimento do sistema;
- o worker de recuperação retoma áudio e revogações, mas não anúncios de ingestão geral;
- o retry manual aceita somente fonte com `status === "failed"`;
- uma fonte presa em `studying` não é reenviada após reinício;
- os testes atuais afirmam que ausência ou falha de `registerSystemDocument` não deve derrubar o envio, consolidando o defeito.

Consequência: uma indisponibilidade temporária entre Norman e LLM-backend pode retornar sucesso ao usuário e deixar documento, texto ou áudio geral armazenado, mas nunca pesquisável por cliente algum.

#### Correção obrigatória

1. Tornar o anúncio da fonte geral uma etapa durável e observável.
2. Persistir antes da resposta o estado do anúncio, tentativas, próxima tentativa e última falha, ou usar uma outbox transacional equivalente.
3. Fazer o worker recuperar anúncios pendentes ou falhos depois de restart, com claim/lease, backoff e idempotência.
4. Tratar a ausência da porta `registerSystemDocument` como configuração inválida ou falha visível, nunca como sucesso.
5. Usar a identidade idempotente já existente de caminho e hash no LLM-backend.
6. Só considerar a etapa confirmada depois de o LLM-backend aceitar o registro.
7. Expor na API e na tela quando a fonte está aguardando registro, falhou ou foi confirmada.
8. Permitir retry manual da etapa de anúncio sem exigir reenvio do arquivo.
9. Preservar a recuperação atual de áudio e revogações.

#### Testes obrigatórios

- Falha antes do primeiro anúncio não produz falso sucesso final.
- Timeout depois de o LLM-backend registrar é reconciliado sem duplicar documento ou job.
- Restart do Norman recupera anúncio pendente de documento, texto e áudio.
- Duas réplicas do worker não anunciam a mesma fonte de forma destrutiva.
- Retry manual funciona para a etapa de anúncio e não exige novo upload.
- Fonte revogada durante a corrida não volta ao acervo.
- Após confirmação, a fonte geral aparece em gerações de dois clientes distintos.

### P1 — Falha de uma camada do RAG derruba ou mascara a outra camada

No LLM-backend, a busca de cliente e a busca de sistema estão dentro do mesmo `try`. Se a consulta de sistema falhar depois de a consulta de cliente funcionar:

- os chunks do cliente já recuperados são descartados;
- `knowledgeUnavailable` é marcado como se a falha fosse do acervo do cliente;
- `systemKnowledgeAvailable` permanece verdadeiro;
- o bloco e a auditoria descrevem a camada errada como indisponível.

Além disso, `dto.knowledgeUnavailable` retorna antes da consulta geral. No caminho legado do Norman, a retenção do cliente também retorna antes de consultar o conhecimento geral. Isso torna as camadas dependentes na direção inversa, embora a arquitetura as defina como independentes.

#### Correção obrigatória

1. Separar a obtenção e o tratamento de erro das camadas de cliente e sistema.
2. Preservar resultados do cliente quando o sistema falhar.
3. Preservar resultados do sistema quando o cliente estiver retido ou sua busca falhar.
4. Se a geração de embedding comum falhar, marcar corretamente as duas buscas como indisponíveis.
5. Fazer `systemKnowledgeAvailable`, `knowledgeUnavailable`, evidências, citações e mensagens refletirem a camada real.
6. Aplicar a mesma independência ao caminho delegado e ao caminho legado.
7. Preservar precedência do cliente em conflito, orçamento por camada, deduplicação e teto conjunto.
8. Operações genéricas continuam sem qualquer camada de conhecimento.

#### Testes obrigatórios

- Busca do sistema lança exceção: cliente continua no contexto e sistema fica indisponível.
- Busca do cliente lança exceção: sistema continua no contexto e cliente fica indisponível.
- Revogação pendente do sistema mantém cliente.
- Revogação pendente do cliente mantém sistema.
- Falha de embedding marca as duas camadas sem produzir evidência falsa.
- Citações e auditoria identificam apenas as camadas realmente usadas.
- Os mesmos casos são cobertos no gateway e no caminho legado do Norman.

## 3. Melhorias necessárias antes da publicação

### P1 — Reforçar a invariável de dono no banco

Os CHECKs novos exigem `user_id IS NULL` nos níveis `client` e `system`, mas não exigem que `organization_id` e `project_id` sejam nulos. Assim, uma linha pode declarar `system` e ainda carregar dono organizacional residual.

Corrigir os CHECKs de `documents` e `document_chunks` para que campos de dono incompatíveis com o nível sejam obrigatoriamente nulos. Manter `project_id` opcional apenas onde ele fizer sentido no nível `person`. Adicionar testes de INSERT direto para todas as combinações inválidas.

### P1 — Rollback do LLM-backend não pode apagar silenciosamente o acervo geral

O `down()` de `KnowledgeScopeLevels1757800000000` executa `DELETE` de documentos, chunks, notas e revogações do sistema. Isto é perda silenciosa de dados numa reversão.

Como o modelo anterior não representa `system`, o rollback deve falhar fechado quando existirem linhas de sistema, orientando backup/exportação e uma ação operacional explícita. Com zero linhas de sistema, o rollback pode prosseguir. O teste do Norman é apenas uma reversão descartável e não uma migration de produção; o relatório e o runbook não devem chamar uma reversão com descarte de dados de reversibilidade segura.

Testar que:

- down sem dados de sistema funciona;
- down com dados de sistema falha antes de apagar qualquer linha;
- nenhuma linha de cliente ou pessoa é alterada na falha;
- o runbook explica a irreversibilidade depois que o acervo geral recebe conteúdo.

### P2 — A tela do acervo geral não permite enviar áudio

O backend expõe `POST /api/admin/ai-knowledge/system/sources` para áudio, mas a API do cliente, os hooks e `SystemKnowledgeSection` oferecem apenas documento e texto. A área de cliente possui upload de áudio; a área geral não.

Adicionar à seção geral o mesmo fluxo de seleção, validação, envio, estado e recuperação de áudio, apontando exclusivamente para a rota de sistema e mantendo as duas permissões exigidas. Cobrir UI, API e autorização. Não misturar o áudio geral com o cliente selecionado.

## 4. Ordem de implementação

1. Fechar a autorização por consumidor no LLM-backend e criar testes HTTP negativos.
2. Implementar estado durável/outbox para anúncio de fontes gerais no Norman.
3. Tornar as duas camadas independentes no gateway e no caminho legado.
4. Reforçar os CHECKs e tornar o rollback do LLM-backend não destrutivo.
5. Completar o upload de áudio na área geral da UI.
6. Rodar os testes focados após cada bloco.
7. Rodar todas as validações finais dos dois repositórios.
8. Refazer o squash para manter exatamente um commit sobre cada base preservada.
9. Não publicar nada e devolver relatório para nova auditoria independente.

## 5. Regressões que continuam proibidas

- Não alterar a ativação em duas fases.
- `NORMAN_AI_FORCE_CONNECTION` deve continuar usando ativação real, persistida e confirmada, nunca `forced:<chave>`.
- Não ampliar operações genéricas com conhecimento de cliente ou do sistema.
- Não liberar prompts de sistema, URLs, credenciais ou modelos fora da allowlist pelo corpo da requisição.
- Não enfraquecer fallback fixado, pin de revisão/modelo, reconciliação de timeout ou auditoria.
- Não quebrar isolamento entre clientes, pessoa/organização ou sistema.
- Não quebrar áudio durável, formatos DOC/XLS/PPTX legados, streaming ou cancelamento.
- Não promover candidato automaticamente; a aprovação administrativa continua obrigatória.
- Não introduzir `clientId` sintético para o sistema.
- Não adicionar comentários, JSDoc, docstrings, TODOs ou FIXMEs ao código novo.

## 6. Validação final obrigatória

### LLM-backend

```sh
npm run typecheck
npm run build
npm test
npm run test:contract
git diff --check aded5b9...HEAD
git rev-list --count aded5b9..HEAD
```

### Norman

```sh
npm run check
npm run check:server
npm run build
npm test
npm run test:coverage
git diff --check 2af225a...HEAD
git rev-list --count 2af225a..HEAD
```

Também é obrigatório:

- executar migrations em PostgreSQL local descartável;
- executar teste HTTP cruzado real entre Norman e LLM-backend;
- procurar segredos nas linhas adicionadas sem reproduzir valores encontrados;
- procurar menções a assistentes, coautoria e geração automática;
- confirmar que todos os arquivos não rastreados anteriores continuam presentes;
- confirmar exatamente um commit depois de cada base;
- não usar credenciais reais.

## 7. Regras de Git e publicação

- Trabalhar nas branches atuais.
- Preservar as bases `aded5b9` e `2af225a`.
- Absorver as correções no único commit de cada branch por squash/amend local.
- Preservar autoria e committer humanos atuais.
- Não incluir este arquivo nem os demais documentos de handoff/planejamento no commit, salvo autorização explícita.
- Não apagar nem modificar arquivos não rastreados que não façam parte da correção.
- Não fazer push.
- Não fazer deploy.
- Não executar migration remota.
- Não executar backfill.
- Não usar credenciais compartilhadas anteriormente.

## 8. Prompt completo para a próxima rodada do Claude

Leia integralmente, antes de alterar qualquer arquivo:

`/Users/diego.alipio/ptw/LLM-backend-Norman/HANDOFF_CODEX_AUDITORIA_MULTIPROVEDOR_2026-09-09.md`

`/Users/diego.alipio/ptw/LLM-backend-Norman/AJUSTE_CONHECIMENTO_GERAL_SISTEMA_2026-09-09.md`

`/Users/diego.alipio/ptw/LLM-backend-Norman/CORRECAO_FINAL_SEGURANCA_DURABILIDADE_RAG_SISTEMA_2026-09-09.md`

O último relatório não passou na auditoria independente, apesar de todas as suítes estarem verdes. Corrija integralmente os bloqueadores e melhorias descritos no terceiro documento nos dois repositórios reais:

- `/Users/diego.alipio/ptw/LLM-backend-Norman`
- `/Users/diego.alipio/ptw/Norman`

Prioridades obrigatórias:

1. Feche todas as rotas internas de documentos e conhecimento por identidade/capacidade do consumidor. O Norman deve continuar autorizado para todas as operações que seus adapters produzem; qualquer outro consumidor deve ficar restrito ao que foi explicitamente concedido e não pode ler, gravar, revogar, renomear, reprocessar ou enumerar conhecimento de cliente ou do sistema.
2. Torne durável o anúncio de documento, texto e áudio geral do Norman ao LLM-backend. Uma falha ou timeout não pode retornar falso sucesso nem deixar fonte presa em `studying`; deve haver estado persistido, retry após restart, idempotência, concorrência segura, visibilidade e retry manual.
3. Torne cliente e sistema independentes em ambos os caminhos de geração. Falha ou retenção de uma camada preserva a outra, com flags, avisos, evidências e citações corretos.
4. Reforce os CHECKs para impedir donos residuais incompatíveis com `knowledge_scope`.
5. Faça o `down()` do LLM-backend falhar antes de qualquer exclusão quando houver conteúdo `system`; não apague o acervo geral silenciosamente.
6. Complete o upload de áudio na seção “Conhecimentos gerais do sistema”, sem depender do cliente selecionado.

Não implemente atalhos por nome de pasta, ausência de `clientId`, `clientId` sintético ou `forced:<chave>`. Não adicione comentários, JSDoc, docstrings, TODOs ou FIXMEs ao código. Use nomes claros e funções pequenas.

Crie os testes negativos e de falha descritos no plano. Não ajuste expectativas para aceitar comportamento inseguro ou perda de durabilidade. Use HTTP real no teste cruzado e PostgreSQL local descartável nas migrations. Não use serviços externos nem credenciais reais.

Ao terminar:

1. Rode todas as validações da seção 6.
2. Confirme que ativação em duas fases, fallback fixado, isolamento, áudio durável, formatos legados, streaming e cancelamento não regrediram.
3. Confirme que `NORMAN_AI_FORCE_CONNECTION` só usa ativação real e confirmada.
4. Faça squash/amend local para deixar exatamente um commit sobre `aded5b9` no LLM-backend e exatamente um commit sobre `2af225a` no Norman.
5. Preserve todos os arquivos não rastreados e mantenha este `.md` não rastreado.
6. Procure segredos e referências a assistentes nos diffs e commits sem reproduzir qualquer segredo.
7. Não faça push, deploy, migration remota ou backfill.

Entregue um relatório objetivo com arquivos alterados, decisões, testes e resultados, hashes finais, contagem de commits sobre cada base, lista de arquivos não rastreados preservados e bloqueios externos ainda pendentes. Aguarde uma nova auditoria do Codex.
