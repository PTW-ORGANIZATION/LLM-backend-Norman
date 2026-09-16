# Correção final — reenvio administrativo e reconciliação concorrente

Data: 2026-09-09

## Veredito da auditoria independente

**Ainda não pronto.**

A rodada baseada em `CORRECAO_FINAL_ATOMICIDADE_OUTBOX_CONCORRENCIA_UI_2026-09-09.md` resolveu os quatro bloqueadores descritos naquele documento e todas as suítes estão verdes. A inspeção do fluxo completo, porém, encontrou uma quebra funcional no ciclo remover → reenviar e uma corrida na compatibilidade com fontes gerais antigas. A substituição concorrente do mesmo caminho também continua sem uma unicidade garantida.

Este arquivo deve permanecer não rastreado. Ele não autoriza push, deploy, migration remota, backfill ou uso de credenciais.

## Estado auditado

### LLM-backend

- Repositório: `/Users/diego.alipio/ptw/LLM-backend-Norman`
- Branch: `feature/formatos-legados-doc-xls-pptx`
- Base: `aded5b945f87e8b1ccdeb72abb7c835fc307093e`
- HEAD: `dc8396b1cb6a8748a9db0c5a026c52e972f9d9b0`
- Commits após a base: exatamente 1

### Norman

- Repositório: `/Users/diego.alipio/ptw/Norman`
- Branch: `feature/finalizacao-camada-conhecimento`
- Base: `2af225aac88a2312e798fc0719587c403fa6d50a`
- HEAD: `233d55473bdb0a178a9933d11535f4264cdd2446`
- Commits após a base: exatamente 1

### Validações reproduzidas

- LLM-backend: typecheck, build, 805 testes e 63 contratos HTTP passaram.
- Norman: check, check de servidor, build e 11.433 testes passaram.
- Cobertura Norman: statements 99,08%, branches 93,65%, functions 98,68%, lines 99,62%.
- Testes focados do novo outbox, repository, migration, rotas e interface: 220 passaram.
- `git diff --check`: limpo nos dois repositórios.
- Nenhuma nova linha de comentário foi adicionada desde os heads anteriores; também não restou comentário adicionado desde `4cddd9ad209`/`643abd900`.
- A busca por segredos encontrou somente strings falsas de teste e descrições de padrões em documentação; nenhuma credencial real.
- Nenhuma referência meta a Claude, ChatGPT ou Codex nas linhas de código adicionadas nem nas mensagens de commit. Há uma referência rastreada a `HANDOFF_OPUS_CONHECIMENTO_DE_IA.md`, tratada abaixo.

## Correções confirmadas e que devem ser preservadas

1. Documento geral nasce com caminho e pendência no mesmo `INSERT`.
2. Substituição da linha anterior e criação da nova estão dentro de uma transação de banco.
3. Texto e transcrição de áudio publicam conteúdo e pendência na mesma atualização condicionada.
4. O encerramento do anúncio usa compare-and-set por claim, estado e versão.
5. Revogação vence uma confirmação tardia.
6. A interface distingue anúncio confirmado, pendente e falho.
7. As constraints do outbox recusam combinações incoerentes.
8. As capacidades internas, a ativação em duas fases e `NORMAN_AI_FORCE_CONNECTION` por ativação real confirmada continuam corretos.
9. Não existe `forced:<chave>` no código de produção.
10. Independência das camadas RAG, isolamento, áudio, formatos legados, streaming, fallback e cancelamento continuam verdes.

## Bloqueadores encontrados

### P0 — o reenvio administrativo não levanta a lápide

O LLM-backend já diferencia dois tipos de registro:

- `repository_sync`: respeita a lápide e não ressuscita conteúdo removido;
- `administrative`: levanta a lápide do caminho antes de registrar um novo envio deliberado.

Essa distinção existe em `RegisterDocumentDto.origin` e no controller do LLM-backend. Porém, o contrato `KnowledgeDocument` do Norman não contém `origin`, o adapter não envia o campo e `rememberSystemKnowledgeFile()` registra o documento sem declarar origem administrativa.

Consequência reproduzível:

1. O administrador adiciona uma fonte geral.
2. O administrador remove a fonte; o LLM-backend grava a lápide do caminho.
3. O administrador envia novamente um arquivo com o mesmo nome/caminho.
4. O Norman cria uma nova fonte atual e anuncia.
5. O LLM-backend interpreta a chamada como sincronização comum e responde `revoked: true`.
6. O Norman encerra o anúncio como `cancelled` embora a nova fonte continue atual.
7. A ficha não oferece retry para `cancelled`, e o texto da interface manda usar um botão que não aparece.

O mesmo princípio vale para um upload deliberado de documento de cliente: a varredura comum precisa continuar respeitando a lápide, mas a ação administrativa explícita deve ter uma rota inequívoca para restaurar somente o arquivo reenviado.

Arquivos centrais:

- `/Users/diego.alipio/ptw/LLM-backend-Norman/src/ingestion/internal-documents.dto.ts`
- `/Users/diego.alipio/ptw/LLM-backend-Norman/src/ingestion/internal-documents.controller.ts`
- `/Users/diego.alipio/ptw/Norman/server/modules/knowledge/knowledge.port.ts`
- `/Users/diego.alipio/ptw/Norman/server/modules/knowledge/llm-backend-knowledge.adapter.ts`
- `/Users/diego.alipio/ptw/Norman/server/modules/knowledge/knowledge.service.ts`
- `/Users/diego.alipio/ptw/Norman/server/modules/ai-knowledge/ai-knowledge.service.ts`

#### Correção exigida

- Adicionar origem tipada ao contrato do adapter, sem tornar `administrative` o default.
- A varredura automática do repositório deve continuar omitindo origem ou enviar explicitamente `repository_sync`.
- Um novo upload deliberado pela administração deve enviar `origin: administrative`.
- A restauração deve levantar somente a lápide exata do arquivo; uma lápide de pasta ancestral continua valendo, conforme a política já implementada.
- Uma resposta atrasada de uma fonte velha/revogada nunca deve usar origem administrativa nem levantar lápide.
- Definir e implementar o caminho explícito equivalente para documentos administrativos de cliente, em vez de depender exclusivamente da varredura que respeita a lápide.
- Se o LLM-backend recusar por uma lápide ancestral, manter estado visível e uma mensagem que não prometa um retry impossível.

#### Testes obrigatórios

- Contrato HTTP real: adicionar fonte geral, remover, reenviar deliberadamente no mesmo caminho e confirmar nova ingestão.
- Confirmar que o novo documento está recuperável para dois clientes e o conteúdo removido não volta.
- Repetir o ciclo para documento administrativo de cliente e confirmar isolamento.
- Sincronização automática depois da remoção continua sem levantar lápide.
- Retry tardio da fonte antiga/revogada não levanta lápide.
- `origin: administrative` exige a mesma capacidade de escrita já prevista e não abre rota para consumidores restritos.
- Estado `cancelled` atual não pode exibir instrução de usar um botão inexistente.

### P1 — a reconciliação de `announceState = null` não é compare-and-set

Para compatibilidade com linhas gerais antigas, `announceSystemSource()` recebe um objeto com estado nulo e chama `updateSource(id, pendingAnnouncementFields())` de forma incondicional antes do claim.

Interleaving de duas réplicas:

1. A e B listam a mesma linha nula.
2. A grava `pending` e toma o lease.
3. B, usando o snapshot antigo, grava `pending` de novo e limpa claim/lease de A.
4. B também toma a linha.
5. As duas fazem a chamada externa.

Outra ordem possível permite que uma atualização atrasada converta `confirmed` de volta para `pending`. O compare-and-set do encerramento não evita isso, pois a regressão ocorre antes do claim.

#### Correção exigida

- Criar uma operação de rearm/reconcile no repositório que faça compare-and-set.
- Ela só pode mudar a linha quando ainda for `system`, atual, não revogada, tiver caminho e `announceState IS NULL`.
- Nunca deve limpar claim/lease nem rebaixar `confirmed`, `failed` ou `cancelled` com base em um snapshot antigo.
- O chamador que perder o compare-and-set deve reler a linha e seguir o estado vencedor.
- O claim continua sendo a única operação que concede posse para chamar o executor.

#### Testes obrigatórios

- Duas réplicas recebem simultaneamente a mesma linha nula; ocorre exatamente uma chamada externa.
- A reconciliação atrasada não muda `confirmed` para `pending`.
- Uma revogação concorrente não é rearmada.
- Claim/lease de outro worker não são apagados.
- Os testes devem exercitar a operação real do repositório/SQL, não somente um fake permissivo.

### P1 — substituições concorrentes do mesmo caminho podem deixar duas fontes atuais

`createSourceReplacing()` tornou retirada e criação atômicas dentro de uma transação, mas a busca da fonte atual acontece antes dela e a retirada atualiza apenas pelo ID, sem verificar vigência/versão. Não existe índice único parcial por caminho atual; há apenas unicidade por hash atual.

Duas requisições concorrentes, com conteúdo diferente e o mesmo nome/caminho, podem observar a mesma versão anterior, retirá-la duas vezes e inserir duas linhas atuais com hashes diferentes para o mesmo `assetPath`. Como o arquivo externo usa o mesmo caminho mutável, também é possível a linha vencedora declarar um hash diferente dos bytes que terminaram armazenados.

#### Correção exigida

- Garantir no banco que exista no máximo uma fonte atual por caminho dentro de cada nível/dono.
- Adicionar índices parciais separados para cliente e sistema, coerentes com os índices atuais por hash.
- Serializar a decisão de substituição pelo par nível/dono/caminho dentro da operação transacional; não confiar em um objeto `existing` lido antes da transação.
- Tratar conflito de concorrência de forma determinística, relendo o vencedor e sem deixar duas fontes atuais.
- Impedir divergência entre `assetPath`, `sha256` da linha atual e o arquivo armazenado. Preferir armazenamento imutável/versionado por conteúdo ou outra estratégia que cubra réplicas diferentes; mutex apenas em memória não é suficiente.
- Preservar histórico: versões perdedoras podem ser revogadas, mas nunca duas podem permanecer atuais.

#### Testes obrigatórios

- Duas substituições simultâneas com hashes diferentes e mesmo caminho deixam exatamente uma fonte atual.
- O hash da fonte atual corresponde aos bytes recuperados do caminho guardado.
- A versão anterior é retirada uma única vez de modo coerente.
- Repetir para nível de cliente e nível de sistema.
- Rodar o teste sobre PostgreSQL local descartável, além dos fakes de serviço.

### P2 — o índice do outbox inclui todas as linhas de cliente

O índice parcial de `0026_knowledge_system_announcement.sql` usa somente `announce_state IS NULL OR ...`. Como toda fonte de cliente tem estado nulo por constraint, todas entram no índice embora a consulta filtre `knowledge_scope = system`, `is_current` e caminho não nulo.

Isso não muda o resultado funcional, mas aumenta o índice e o custo da migration sem benefício.

#### Melhoria exigida

Alinhar o predicado do índice com o conjunto consultável do outbox, incluindo pelo menos nível de sistema, vigência e estados abertos/nulos. Confirmar com teste de definição do índice e plano de consulta quando suportado pelo harness.

### P2 — documentação rastreada cita um handoff associado a assistente

`RELATORIO_AJUSTES_POS_AUDITORIA_2026-09-08.md`, que faz parte do commit do LLM-backend, cita nominalmente o arquivo local `HANDOFF_OPUS_CONHECIMENTO_DE_IA.md`. O arquivo não rastreado deve ser preservado, mas a referência meta não precisa ser publicada no repositório.

Substituir somente essa menção no documento rastreado por uma descrição neutra, como “handoffs locais não rastreados”, sem adicionar nome de assistente e sem rastrear ou apagar o arquivo original.

## Regras da implementação

- Não adicionar comentários de linha, bloco, JSDoc, docstrings, TODO, FIXME ou comentários de lint em código, migrations ou testes.
- Não remover comentários preexistentes que estejam fora dos trechos inevitavelmente modificados.
- Expressar intenção por nomes, tipos, funções pequenas e testes.
- Preservar todos os arquivos não rastreados, inclusive este.
- Não usar credenciais compartilhadas anteriormente.
- Não fazer push, deploy, migration remota ou backfill.
- Manter exatamente um commit local depois de cada base, com autoria e committer humanos já usados.

## Auditoria final obrigatória

1. Demonstrar os defeitos com testes que falhem nos heads auditados.
2. Implementar somente as correções acima e preservar tudo que já passou.
3. Rerodar typecheck/check, builds, suítes completas, cobertura e contratos HTTP cruzados.
4. Rerodar migrations up/down/up nos bancos locais descartáveis.
5. Revalidar capacidades, ausência de efeitos após 403, duas fases, ativação real confirmada, fallback fixado, camadas independentes, isolamento, áudio, formatos legados, streaming e cancelamento.
6. Procurar segredos reais e referências meta a assistentes nas linhas adicionadas e nas mensagens de commit.
7. Confirmar zero comentários novos desde `dc8396b1` e `233d5547`.
8. Confirmar ausência de nomes de assistentes, inclusive nomes de modelos como `Opus`, em documentação rastreada e mensagens de commit, sem tratar nomes técnicos de protocolo como `anthropic_messages` como referência meta.
9. Confirmar `git diff --check` limpo, hashes, bases, autoria e exatamente um commit por base.

## Prompt completo para o Claude

```text
Leia integralmente antes de alterar qualquer arquivo:

/Users/diego.alipio/ptw/LLM-backend-Norman/HANDOFF_CODEX_AUDITORIA_MULTIPROVEDOR_2026-09-09.md
/Users/diego.alipio/ptw/LLM-backend-Norman/CORRECAO_FINAL_ATOMICIDADE_OUTBOX_CONCORRENCIA_UI_2026-09-09.md
/Users/diego.alipio/ptw/LLM-backend-Norman/CORRECAO_FINAL_REUPLOAD_RECONCILIACAO_CONCORRENTE_2026-09-09.md

Trabalhe nos repositórios:

- /Users/diego.alipio/ptw/LLM-backend-Norman
- /Users/diego.alipio/ptw/Norman

Parta destes estados, conferindo-os antes de começar:

- LLM-backend: feature/formatos-legados-doc-xls-pptx, HEAD dc8396b1cb6a8748a9db0c5a026c52e972f9d9b0, base aded5b945f87e8b1ccdeb72abb7c835fc307093e.
- Norman: feature/finalizacao-camada-conhecimento, HEAD 233d55473bdb0a178a9933d11535f4264cdd2446, base 2af225aac88a2312e798fc0719587c403fa6d50a.

Não reinicie a implementação. Preserve todas as correções já aprovadas. Antes de implementar, escreva testes que falhem no estado atual e comprovem:

1. Remover e reenviar deliberadamente uma fonte geral no mesmo caminho levanta somente a lápide exata, volta a ingerir e fica recuperável por dois clientes.
2. O mesmo ciclo funciona para documento administrativo de cliente sem quebrar isolamento.
3. Sincronização automática e retry atrasado de fonte velha nunca levantam lápide.
4. Duas réplicas reconciliando simultaneamente announceState nulo produzem uma única chamada externa; reconciliação atrasada não regride confirmed, não ressuscita revogada e não apaga claim/lease alheio.
5. Duas substituições simultâneas com hashes diferentes no mesmo caminho deixam uma única fonte atual, cujo hash corresponde aos bytes armazenados, tanto para client quanto system.

Implemente os três bloqueadores e os dois ajustes P2 exatamente como descritos no novo documento. A origem administrative deve existir somente no caminho de uma ação administrativa deliberada; repository_sync continua respeitando lápides. Use compare-and-set real para rearmar linhas antigas. Garanta unicidade por caminho e consistência arquivo/hash sob concorrência entre réplicas. Neutralize a referência rastreada a HANDOFF_OPUS sem apagar nem rastrear o arquivo local.

Não adicione comentários de linha, bloco, JSDoc, docstrings, TODO, FIXME ou comentários de lint em código, migrations ou testes. Não remova comentários preexistentes fora de trechos inevitavelmente modificados. Use nomes, tipos, funções pequenas e testes para expressar intenção.

Rode validações completas nos dois repositórios, cobertura, migrations locais up/down/up e contratos HTTP cruzados. Revalide autorização e todas as regressões listadas no documento. Faça busca de segredos e referências meta a assistentes. Preserve todos os arquivos não rastreados. Faça squash/amend para manter exatamente um commit depois de cada base com autoria humana.

Não faça push, deploy, migration remota ou backfill. Não use credenciais compartilhadas anteriormente.

Ao terminar, relate os testes que falharam antes, os arquivos alterados, resultados exatos, hashes finais, bases, quantidade de commits, arquivos não rastreados e bloqueios externos. Pare para nova auditoria independente do Codex.
```
