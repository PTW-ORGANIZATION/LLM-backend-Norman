# Correção final — atomicidade do outbox, concorrência e retorno visível

Data: 2026-09-09

## Resultado da auditoria independente

**Ainda não pronto.**

A rodada anterior resolveu os bloqueadores de autorização interna, independência das camadas RAG, restrições de banco, rollback não destrutivo, áudio geral e ativação fixada. As suítes completas estão verdes. Porém, a implementação do anúncio durável ainda contém duas falhas de consistência e a interface comunica sucesso mesmo quando o primeiro anúncio falha.

Este documento é corretivo e deve permanecer não rastreado. Ele não autoriza push, deploy, migration remota, backfill ou uso de credenciais.

## Estado auditado

### LLM-backend

- Repositório: `/Users/diego.alipio/ptw/LLM-backend-Norman`
- Branch: `feature/formatos-legados-doc-xls-pptx`
- Base: `aded5b945f87e8b1ccdeb72abb7c835fc307093e`
- HEAD: `409795fac7a7982ff9330b1e5c299b6d403c8b83`
- Commits depois da base: exatamente 1
- `git diff --check`: limpo

### Norman

- Repositório: `/Users/diego.alipio/ptw/Norman`
- Branch: `feature/finalizacao-camada-conhecimento`
- Base: `2af225aac88a2312e798fc0719587c403fa6d50a`
- HEAD: `a13f0f0cb999a9881e5833eff515da23ecf455a6`
- Commits depois da base: exatamente 1
- `git diff --check`: limpo

### Testes reproduzidos

- LLM-backend: typecheck e build passaram.
- LLM-backend: 55 arquivos passaram, 2 ignorados; 805 testes passaram, 16 ignorados.
- Contratos HTTP cruzados: 3 arquivos; 63 testes passaram.
- Norman: check, check de servidor e build passaram.
- Norman: 457 arquivos passaram, 1 ignorado; 11.402 testes passaram, 4 ignorados.
- Cobertura Norman: statements 99,08%, branches 93,64%, functions 98,70%, lines 99,62%.
- Avisos de bundle e `HTMLMediaElement.play()` são preexistentes/não bloqueadores.

## O que está correto e deve ser preservado

1. A matriz de capacidades internas separa leitura e escrita de cliente, sistema, extração e administração de conexões.
2. O token do Norman recebe todas as capacidades necessárias aos adapters que ele produz; consumidores sem declaração recebem zero capacidades.
3. Os testes HTTP negativos comprovam 403 antes de banco, fila, embedding, extração e multipart.
4. `NORMAN_AI_FORCE_CONNECTION` resolve uma ativação real e confirmada, validada contra o executor. Não existe `forced:<chave>` no código de produção.
5. As camadas de conhecimento do cliente e do sistema são consultadas, retidas e degradadas separadamente nos caminhos gateway e legado.
6. As constraints exigem identificadores de tenant nulos nos níveis `client` e `system`.
7. O `down()` recusa antes de alterar dados quando existe conhecimento de sistema.
8. Upload de áudio geral usa a rota de sistema e não herda o cliente selecionado.
9. Ativação em duas fases, fallback fixado, isolamento, formatos legados, streaming e cancelamento continuam verdes nas suítes existentes.

## Bloqueadores objetivos

### P0 — a pendência do outbox não é atômica com a publicação

O relatório anterior afirma que a pendência é persistida antes da tentativa, mas ela é gravada em uma operação separada da criação/publicação da fonte.

No fluxo de documento geral:

1. `registerDocumentAt()` cria a fonte em `studying` sem `assetPath` e sem `announceState`.
2. Outra atualização grava `assetPath`.
3. Somente depois `addDocumentAt()` chama `markAnnouncementPending()`.
4. Só então ocorre a tentativa de anúncio.

Uma queda entre 1/2 e 3 deixa uma fonte atual publicada com `announceState = null`. O worker consulta apenas `pending` ou `failed`, portanto jamais a encontra. Um reenvio com o mesmo hash cai na deduplicação e também não rearma a pendência.

No fluxo de texto e no resultado da transcrição de áudio ocorre a mesma classe de falha:

1. `publishContent()` faz `advance()` para `studying`, grava caminho e transcrição.
2. Depois chama separadamente `markAnnouncementPending()`.

Uma queda nesse intervalo deixa a fonte publicada fora do outbox. Os testes atuais de reinício começam depois de uma tentativa de rede já ter gravado `failed`; eles não simulam a queda entre a escrita do conteúdo e a criação da pendência.

Arquivos centrais:

- `/Users/diego.alipio/ptw/Norman/server/modules/ai-knowledge/ai-knowledge.service.ts`
- `/Users/diego.alipio/ptw/Norman/server/modules/ai-knowledge/ai-knowledge.repository.ts`
- `/Users/diego.alipio/ptw/Norman/server/modules/ai-knowledge/ai-knowledge.types.ts`

#### Correção exigida

- Documento de sistema: criar a fonte, o `assetPath` e `announceState = pending` na mesma escrita/mesma transação lógica. Estender o tipo de criação da fonte para aceitar os campos necessários, sem uma atualização intermediária.
- Texto/áudio de sistema: incluir `announceState = pending`, `announceNextAttemptAt`, limpeza de claim/lease e demais campos coerentes na mesma atualização condicionada que publica o conteúdo.
- Conteúdo de cliente continua sem anúncio de sistema.
- Se uma composição realmente exigir mais de uma tabela/escrita, usar uma transação real; não aceitar compensação em memória como substituta.
- Deduplicação de fonte geral deve reconciliar uma linha atual que, por dado legado ou estado impossível anterior, esteja sem estado de anúncio. Ela não pode apenas retornar `duplicate` e deixá-la invisível.
- Não chamar o executor antes do commit da fonte e da pendência.

#### Testes obrigatórios

- Documento: simular queda imediatamente depois da escrita de negócio e antes de qualquer chamada de rede; construir uma nova instância do serviço/worker e confirmar retomada sem reenvio e sem duplicação.
- Texto: o mesmo cenário.
- Áudio após transcrição: o mesmo cenário.
- Deduplicação reconcilia fonte geral atual com anúncio ausente, sem criar nova fonte.
- Fonte de cliente nunca entra no outbox de sistema.

Os testes devem falhar contra `a13f0f0` e passar somente após a correção.

### P1 — resultado do claim é encerrado sem compare-and-set

`claimAnnouncement()` toma a linha com `claimedBy` e lease, mas `settleAnnouncement()` encerra a tentativa com um `updateSource(id, patch)` incondicional. Ele não exige que a linha ainda pertença ao mesmo worker, esteja em estado aberto, mantenha a mesma versão e continue atual.

Isso permite duas corrupções:

- Worker A toma a fonte, expira; worker B retoma e confirma; A termina atrasado com erro e sobrescreve `confirmed` por `failed`.
- Worker A toma a fonte; um administrador revoga/cancela durante a chamada externa; A recebe sucesso atrasado e sobrescreve `cancelled` por `confirmed`.

O teste existente de duas réplicas cobre apenas claims simultâneos enquanto a lease está válida. O teste de revogação cobre revogação anterior ao claim. Nenhum cobre encerramento atrasado depois da troca de proprietário ou cancelamento.

#### Correção exigida

- Criar operação de encerramento condicional no repositório.
- Ela deve atualizar somente quando `id`, `announceClaimedBy`, estado aberto e demais precondições de posse ainda coincidirem.
- Confirmação também deve exigir fonte atual/não revogada e a versão de processamento esperada.
- Cancelamento/revogação tem precedência sobre respostas tardias.
- Se o compare-and-set perder, buscar e devolver o estado atual sem sobrescrevê-lo.
- Preservar a lápide do LLM-backend como defesa secundária; ela não substitui consistência no Norman.

#### Testes obrigatórios

- A toma; lease expira; B toma e confirma; A falha atrasado; estado final continua `confirmed`.
- A toma; fonte é revogada/cancelada; A confirma atrasado; estado final continua `cancelled`/revogado.
- Retry manual concorrente não ressuscita fonte revogada.
- Contadores, próximo retry, erro e timestamps pertencem somente ao encerramento vencedor.

### P1 — a resposta imediata ainda comunica sucesso falso

As rotas aceitam armazenamento com anúncio falho e retornam 202, expondo `announced: false`. Isso pode ser válido como contrato assíncrono, mas a interface ignora o resultado:

- documentos sempre mostram “Documentos enviados ao acervo geral” e “em estudo” para todos os aceitos;
- texto descarta o retorno da mutation e sempre mostra “Conhecimento geral registrado”.

Quando a porta está ausente ou a primeira chamada falha, o estado persistido é `failed`; a mensagem imediata não pode afirmar registro/estudo concluído. A ficha posterior com botão de retry é útil, mas não corrige a mensagem falsa já exibida.

#### Correção exigida

- Tornar explícito no contrato cliente/servidor o estado `pending`, `confirmed`, `failed` ou `cancelled` de cada item armazenado.
- É aceitável manter 202 para armazenamento durável/assíncrono, desde que a UI diga com precisão que o arquivo foi guardado e que o anúncio está pendente ou falhou.
- Para falha imediata, usar aviso/erro visível e não usar “registrado”, “em estudo” ou equivalente a sucesso final.
- Em lote, distinguir itens confirmados/pendentes dos falhos, sem contar todos na mesma mensagem de sucesso.
- Preservar retry manual e atualização automática da ficha.

#### Testes obrigatórios

- Falha inicial de documento não mostra texto de sucesso final.
- Falha inicial de texto não mostra “Conhecimento geral registrado”.
- Lote misto apresenta contagens/estados corretos.
- Pendente e confirmado têm mensagens distintas e verdadeiras.

### P1 — a rodada descumpriu a regra explícita de não adicionar comentários

Na diferença da rodada auditada foram adicionadas aproximadamente 552 linhas iniciadas como comentário/JSDoc/SQL comment:

- LLM-backend, de `4cddd9ad209` até `409795f`: 286.
- Norman, de `643abd900` até `a13f0f0`: 266.

A instrução era explícita: não adicionar comentários de linha/bloco, JSDoc, docstrings, TODO ou FIXME. Essa restrição também vale para migrations e testes.

#### Correção exigida

- Remover somente os comentários introduzidos desde os dois heads anteriores indicados acima.
- Não remover comentários que já existiam nas bases da rodada.
- Não adicionar novos comentários durante esta correção.
- Expressar intenção por nomes, funções pequenas, tipos, mensagens de erro e testes.
- Documentação Markdown não é código e pode continuar detalhada.

## Reforço opcional de invariantes

Se couber sem ampliar o escopo, adicionar constraints que impeçam estados impossíveis do outbox, por exemplo:

- conhecimento de cliente não pode ter estado/claim/lease de anúncio de sistema;
- `confirmed` requer `announceConfirmedAt` e não pode manter retry/claim/lease;
- `cancelled` não pode manter próximo retry/claim/lease;
- estados abertos não podem carregar timestamp de confirmação.

Qualquer constraint adicionada precisa de teste por `INSERT` ou `UPDATE` direto e migration reversível conforme as regras já aceitas.

## Auditoria final obrigatória

1. Ler integralmente os handoffs e planos já existentes, inclusive este arquivo.
2. Implementar somente os bloqueadores acima, preservando as correções aceitas.
3. Rerodar typecheck/check, builds, suítes completas e contratos HTTP cruzados.
4. Rerodar migrations em PostgreSQL local descartável, incluindo up/down/up e novas constraints.
5. Confirmar cenários de queda entre escrita e rede, perda de lease e resposta tardia depois de revogação.
6. Confirmar ausência de regressão em autorização, token do Norman, duas fases, `NORMAN_AI_FORCE_CONNECTION`, fallback, camadas, isolamento, áudio, formatos legados, streaming e cancelamento.
7. Procurar segredos e referências meta a assistentes nas linhas adicionadas e mensagens de commit. `anthropic_messages` como nome de protocolo não é referência meta indevida.
8. Confirmar `git diff --check` limpo.
9. Preservar todos os arquivos não rastreados, inclusive este.
10. Fazer squash local para manter exatamente um commit depois de cada base, com autoria e committer humanos já usados.
11. Não fazer push, deploy, migration remota ou backfill.
12. Não usar credenciais compartilhadas anteriormente.

## Prompt completo para a próxima rodada do Claude

```text
Leia integralmente, antes de alterar qualquer arquivo:

/Users/diego.alipio/ptw/LLM-backend-Norman/HANDOFF_CODEX_AUDITORIA_MULTIPROVEDOR_2026-09-09.md
/Users/diego.alipio/ptw/LLM-backend-Norman/CORRECAO_FINAL_SEGURANCA_DURABILIDADE_RAG_SISTEMA_2026-09-09.md
/Users/diego.alipio/ptw/LLM-backend-Norman/CORRECAO_FINAL_ATOMICIDADE_OUTBOX_CONCORRENCIA_UI_2026-09-09.md

Trabalhe nos repositórios:

- /Users/diego.alipio/ptw/LLM-backend-Norman
- /Users/diego.alipio/ptw/Norman

Estado esperado de partida:

- LLM-backend: branch feature/formatos-legados-doc-xls-pptx, HEAD 409795fac7a7982ff9330b1e5c299b6d403c8b83, base aded5b945f87e8b1ccdeb72abb7c835fc307093e.
- Norman: branch feature/finalizacao-camada-conhecimento, HEAD a13f0f0cb999a9881e5833eff515da23ecf455a6, base 2af225aac88a2312e798fc0719587c403fa6d50a.

Não reinicie a implementação. Preserve tudo o que a auditoria marcou como correto. Corrija somente os bloqueadores do novo documento:

1. Faça a criação da pendência do anúncio atômica com a publicação da fonte de sistema. Documento deve nascer com assetPath e pending na mesma escrita/transação lógica. Texto e áudio devem publicar conteúdo e pending na mesma atualização condicionada. Não pode existir janela em que uma queda deixe fonte atual em studying com announceState nulo. A deduplicação deve reconciliar qualquer fonte geral atual sem anúncio.
2. Troque o encerramento incondicional por compare-and-set: somente o worker que ainda possui o claim pode encerrar; confirmação exige fonte atual/não revogada e versão esperada; cancelamento/revogação vence qualquer resposta tardia. Se perder a condição, leia e devolva o estado vencedor sem sobrescrever.
3. Corrija API/UI para nunca afirmar registro/estudo final quando o anúncio inicial estiver pending, failed ou cancelled. Em lotes, diferencie cada estado e teste as mensagens.
4. Remova apenas os comentários/JSDoc/docstrings/TODO/FIXME/SQL comments introduzidos desde 4cddd9ad209 no LLM-backend e desde 643abd900 no Norman. Não adicione comentário algum em código, migrations ou testes nesta rodada. Preserve comentários anteriores às bases e use nomes, tipos, funções e testes para expressar intenção.

Antes de implementar, escreva testes que falhem no estado atual para:

- queda depois da escrita do documento e antes da chamada de rede, seguida de nova instância/worker;
- a mesma queda para texto e áudio após transcrição;
- deduplicação de fonte geral atual sem announceState;
- worker A perde lease, B confirma e A falha tarde, sem sobrescrever confirmed;
- revogação/cancelamento durante request e confirmação atrasada, sem ressurreição;
- contadores e timestamps pertencendo somente ao settlement vencedor;
- falha inicial de texto/documento sem toast de sucesso falso;
- lote misto com mensagens e contagens por estado.

Rode as validações completas dos dois repositórios, contratos HTTP cruzados, cobertura e migrations PostgreSQL locais descartáveis. Verifique também que continuam corretos: capacidades internas, todas as operações produzidas pelos adapters do Norman, bloqueio dos demais consumidores antes de efeitos colaterais, ativação em duas fases, NORMAN_AI_FORCE_CONNECTION baseado em ativação real confirmada e nunca forced:<chave>, fallback fixado, independência das camadas RAG, isolamento, conhecimento geral, áudio, formatos legados, streaming e cancelamento.

Faça busca de segredos e de referências meta a assistentes nas linhas adicionadas e commits. Preserve todos os arquivos não rastreados. Mantenha exatamente um commit local depois de cada base por squash/amend, com autoria e committer humanos existentes.

Não faça push, deploy, migration remota ou backfill. Não use credenciais compartilhadas anteriormente.

Ao terminar, informe arquivos alterados, testes novos, comandos e resultados exatos, hashes/base/quantidade de commits, estados não rastreados e bloqueios externos. Pare para nova auditoria independente do Codex.
```

