# Ajuste corretivo — conhecimento geral do sistema e alinhamento da arquitetura

**Data:** 09/09/2026  
**Repositórios:** `LLM-backend-Norman` e `Norman`  
**Estado inicial auditado:** implementação local, sem push, deploy, migration remota ou backfill  
**Decisão do produto:** a área de conhecimentos gerais foi solicitada pelo usuário e precisa existir de forma funcional, não apenas ilustrativa.

## 1. Motivo desta rodada

A implementação atual possui **Conhecimentos gerais do cliente**. Toda fonte dessa área recebe um `clientId`, fica dentro da pasta do cliente e só participa das gerações desse cliente.

Os materiais complementares descrevem também um segundo nível:

- **Conhecimento geral do sistema**, administrado uma vez e compartilhado com todos os clientes;
- **Conhecimento específico do cliente**, privado e combinado com o geral durante uma geração vinculada a cliente.

O nível geral do sistema ainda não existe no código. Não tratar isso como simples mudança de rótulo: são dois escopos de dados e autorização diferentes.

## 2. Estado Git que deve ser preservado

### LLM-backend

- caminho: `/Users/diego.alipio/ptw/LLM-backend-Norman`
- branch: `feature/formatos-legados-doc-xls-pptx`
- base: `aded5b9`
- HEAD inicial: `889284adf4eb28798abb5bd9229ff5d56c0af2b1`
- deve terminar com exatamente um commit sobre a base

### Norman

- caminho: `/Users/diego.alipio/ptw/Norman`
- branch: `feature/finalizacao-camada-conhecimento`
- base: `2af225a`
- HEAD inicial: `798200206e547d054f6476b124592337fe7f5232`
- deve terminar com exatamente um commit sobre a base

Preservar todos os arquivos não rastreados. Não limpar o worktree e não remover nenhum documento de planejamento ou handoff.

## 3. Contrato funcional obrigatório

Devem existir dois escopos explícitos:

1. `system`: conhecimento geral do Norman, sem dono cliente, compartilhado nas gerações vinculadas a cliente;
2. `client`: conhecimento privado de um `clientId`, incluindo a atual área **Conhecimentos gerais do cliente**.

Para uma operação vinculada ao cliente A, a recuperação deve consultar:

- conhecimento `system` vigente e autorizado;
- conhecimento `client` cujo `clientId` seja exatamente A.

Nunca pode consultar conteúdo do cliente B. O conhecimento do cliente deve prevalecer quando houver conflito com uma regra geral do sistema.

Operações genéricas sem `clientId` devem continuar sem acesso ao conhecimento de clientes. Não ampliar o contrato das operações genéricas nesta rodada. Se o produto vier a decidir que uma operação genérica pode consultar o acervo `system`, isso deve ser uma decisão e uma operação explícitas, com testes próprios.

## 4. Modelagem e isolamento

Não implementar o escopo geral com:

- `clientId` sintético, reservado ou mágico;
- ausência de filtro de cliente;
- uma pasta chamada `geral` tratada como barreira de segurança;
- inferência pelo nome ou caminho do arquivo.

Usar um discriminador persistido e explícito de escopo. A solução deve representar `system`, `client` e os escopos pessoais já existentes sem ambiguidade. Ajustar constraints, índices, entities, repositories, DTOs e migrations locais conforme necessário.

O banco deve continuar impondo que cada documento, chunk, nota ou fonte pertença a exatamente um escopo válido. Para `client`, `clientId` continua obrigatório. Para `system`, `clientId` deve ser nulo e a linha deve ser identificada como `system`. Fazer backfill determinístico das linhas já existentes para os escopos atuais; não executar migration em ambiente remoto.

O caminho físico é apenas organização operacional. A autorização e o isolamento devem continuar baseados em metadados persistidos e filtros no banco. Não hardcode `/storage/norma_knowledge` se o backend ativo usa Drive, Supabase ou outro storage.

## 5. Norman — plano de controle e interface

Na área administrativa **Conhecimento de IA**, expor claramente:

- **Conhecimentos gerais do sistema**;
- seleção de cliente e **Conhecimentos gerais do cliente**;
- **Aprendizados por cliente**.

Não renomear a área atual do cliente como se ela já fosse global. As duas devem aparecer como destinos distintos e sem ambiguidade na interface, API e auditoria.

Mutação do acervo `system` deve exigir simultaneamente:

- `aiKnowledge.manage`;
- acesso transversal, hoje representado por `assets.crossClient`, ou uma nova permissão global ainda mais específica se a arquitetura justificar.

Administradores restritos a clientes podem continuar administrando somente os clientes dentro do seu escopo. Upload, listagem, retry, revogação e consulta de status do acervo `system` devem ter testes positivos e negativos de autorização.

Uploads de documentos e áudio devem continuar usando os formatos, limites, validação, durabilidade, versionamento, auditoria e revogação já implementados. Criar um destino canônico para fontes `system`, sem colocá-las sob a pasta de qualquer cliente.

## 6. LLM-backend — ingestão e recuperação

Estender o contrato interno de ingestão para transportar o escopo de forma explícita e validada. Compatibilidade não pode significar adivinhar `system` por caminho ou por falta acidental de `clientId`.

Na geração vinculada a cliente:

1. recuperar o conjunto `system` com filtro explícito;
2. recuperar o conjunto do `clientId` autorizado com filtro explícito;
3. aplicar limiar de evidência e orçamento de contexto a cada camada;
4. mesclar com precedência do cliente sobre o sistema;
5. deduplicar fontes e trechos;
6. registrar nas evidências e citações se cada item veio de `system` ou `client`.

Não usar uma única consulta sem trava para representar a união. Os filtros das duas camadas precisam ser visíveis e testáveis.

Se uma revogação `system` estiver pendente ou falhar, a camada `system` deve ficar fora de novas gerações até a invalidação ser confirmada. O conhecimento privado do cliente pode continuar disponível, desde que a resposta e a auditoria indiquem de forma determinística que a camada geral estava indisponível. A remoção confirmada precisa fazer a fonte geral parar de aparecer para todos os clientes.

Manter as garantias já auditadas:

- ativação em duas fases;
- ativação real, confirmada e determinística;
- nunca usar `forced:<chave>` como ativação;
- revisão e modelo fixados na ativação;
- fallback fixado;
- autorização das operações genéricas e `NORMAN_AI_FORCE_CONNECTION`;
- token do Norman limitado às operações que o adapter produz;
- streaming e cancelamento;
- áudio durável;
- formatos modernos e legados;
- citações, dossier, tokens estruturados e identificadores;
- isolamento entre clientes;
- revogação sem ressurreição.

## 7. Aprendizado por conversa

Os materiais complementares mostram uma triagem automática de prompts e sugerem salvar conteúdo como fato. Isso não autoriza persistência automática no acervo oficial.

Nesta rodada:

- manter o fluxo atual `candidato -> aprovação administrativa -> fonte oficial`;
- não salvar automaticamente mensagens ou respostas como conhecimento permanente;
- não promover candidato por decisão de um LLM;
- não usar Ollama ou qualquer provedor como trava de segurança ou autorização;
- não criar uma análise obrigatória de todo prompt se isso ainda não existe.

Uma futura extração automática pode apenas sugerir candidatos, de forma assíncrona, com origem, referência da conversa, deduplicação e filtragem de dados sensíveis. Ela fica fora desta rodada até decisão explícita do produto.

## 8. Itens dos diagramas que não devem virar comportamento por acidente

- **Grok** é o modelo/produto da xAI. **Groq** é outro provedor e hoje atende usos específicos, como transcrição. Corrigir a terminologia na documentação; não hardcode nenhum deles no fluxo multiprovedor.
- Ollama é runtime/provedor local e pode executar embeddings ou modelos. Ele não é o orquestrador nem a barreira de isolamento.
- O losango `conteúdo adequado? -> busca adicional` representa um possível loop iterativo de RAG que não fazia parte do aceite original. Não implementar nesta rodada. Se for adotado no futuro, deverá ter limite de tentativas, orçamento de custo/latência, propagação de cancelamento e auditoria por passagem.
- O upload e a aprovação são administrativos. Não transformar a frase genérica `o usuário pode salvar` em permissão para qualquer usuário final.
- Pastas físicas são uma visualização operacional, não o mecanismo de segurança.

## 9. Testes mínimos novos

Adicionar testes unitários, de integração e de contrato que provem:

1. fonte `system` fica visível numa geração do cliente A;
2. a mesma fonte `system` fica visível numa geração do cliente B;
3. fonte privada de A nunca aparece para B;
4. fonte privada de B nunca aparece para A;
5. conflito entre regra geral e regra do cliente usa a regra do cliente;
6. operação genérica não recebe silenciosamente nenhum acervo de cliente;
7. upload global exige autorização transversal;
8. administrador restrito a A não consegue criar, alterar, remover ou listar acervo global;
9. `clientId` sintético ou escopo inválido é recusado;
10. revogação global confirmada remove a evidência de A e B;
11. revogação global pendente impede o uso da camada global sem liberar consulta ampla;
12. citações e auditoria distinguem `system` de `client`;
13. migrations novas sobem e descem em PostgreSQL limpo;
14. dados preexistentes são classificados corretamente pela migration;
15. todos os testes de isolamento, ativação, fallback, áudio, formatos, streaming e cancelamento continuam verdes.

Criar também um teste HTTP cruzado real entre os dois serviços para ingestão global e geração por dois clientes, usando os controllers, guards, DTOs e bancos PostgreSQL reais das suítes de contrato. Não aceitar mocks que eliminem os filtros de escopo.

## 10. Validação completa obrigatória

### LLM-backend

Executar:

- `npm run typecheck`
- `npm run build`
- `npm test`
- `npm run test:contract`
- migrations `up` e `down` em PostgreSQL descartável

### Norman

Executar:

- `npm run check`
- `npm run check:server`
- `npm run build`
- `npm test`
- `npm run test:coverage`
- migrations `up` e `down` em PostgreSQL descartável

Comparar cobertura com a base e não reduzir os pisos. Executar `git diff --check`, busca por segredos e busca por referências a assistentes no diff e no commit final.

## 11. Git, segurança e limites de publicação

- Não usar credencial reproduzida em handoff, relatório, histórico ou shell.
- Não fazer push.
- Não fazer deploy.
- Não executar migration remota.
- Não executar backfill remoto.
- Não testar com cliente real.
- Não apagar arquivos não rastreados.
- Não adicionar comentários ao código.
- Preservar autoria e committer exigidos pelo projeto.
- Ao final, fazer squash para exatamente um commit sobre `aded5b9` no LLM-backend e um commit sobre `2af225a` no Norman.

## 12. Documentação de encerramento

Criar um adendo arquitetural em Markdown que declare, sem ambiguidades:

- diferença entre conhecimento geral do sistema e conhecimento geral do cliente;
- matriz de visibilidade por escopo;
- quem pode administrar cada nível;
- precedência `client > system`;
- pastas como organização, não autorização;
- candidato nunca é conhecimento oficial antes da aprovação;
- Ollama/Grok/Groq e demais provedores como adapters/runtimes, nunca como fonte da verdade ou trava de segurança;
- loop de busca adicional como possibilidade futura, não comportamento atual.

Não editar os PDFs binários nesta rodada. Registrar no relatório os problemas editoriais encontrados: referências `[cite: ...]` sem bibliografia, diagrama quebrado entre páginas e confusão entre Grok/Groq.

## 13. Relatório esperado do Claude

O relatório final deve conter:

- resumo da modelagem escolhida e das migrations;
- lista de endpoints e telas alterados;
- matriz de autorização;
- consulta de recuperação das duas camadas e regra de precedência;
- evidência dos 15 testes mínimos;
- resultados completos das suítes e cobertura;
- provas de migration `up/down`;
- HEAD, base, branch e contagem de commits de cada repositório;
- lista integral de arquivos não rastreados preservados;
- confirmação de ausência de segredo e referência a assistente;
- confirmação de que não houve push, deploy, migration remota ou backfill.

## Prompt completo para executar no Claude

Leia integralmente, antes de alterar qualquer arquivo:

`/Users/diego.alipio/ptw/LLM-backend-Norman/HANDOFF_CODEX_AUDITORIA_MULTIPROVEDOR_2026-09-09.md`

e depois:

`/Users/diego.alipio/ptw/LLM-backend-Norman/AJUSTE_CONHECIMENTO_GERAL_SISTEMA_2026-09-09.md`

Implemente integralmente o segundo documento nos dois repositórios reais. A decisão de produto é que devem existir dois escopos diferentes: conhecimento geral do sistema, compartilhado nas gerações vinculadas a cliente, e conhecimento geral do cliente, privado. Não use `clientId` artificial, ausência de filtro ou nome de pasta como mecanismo de segurança.

Preserve todas as garantias já auditadas do gateway multiprovedor e da camada de conhecimento. Não implemente persistência automática de conversas, Ollama como trava de segurança ou loop iterativo de RAG; esses pontos dos diagramas não pertencem a esta rodada. Corrija a documentação em um adendo Markdown, inclusive a distinção Grok/Groq.

Não confie somente nos testes existentes: crie os testes de isolamento, precedência, autorização, revogação, citações, migrations e HTTP cruzado exigidos no plano. Rerode todas as suítes, cobertura, builds, verificações de tipos e migrations locais.

Ao terminar, faça squash para exatamente um commit sobre cada base preservada. Não apague arquivos não rastreados. Não faça push, deploy, migration remota ou backfill. Não use credenciais compartilhadas anteriormente. Entregue o relatório completo da seção 13 e aguarde nova auditoria do Codex.
