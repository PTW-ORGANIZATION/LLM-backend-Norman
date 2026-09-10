# Relatório da implementação: camada de conhecimento e gateway multiprovedor

Data: 08/09/2026.
Escopo executado: implementação local verificada, pronta para revisão.
Fora da autorização e **não executados**: push, PR, merge, tag, workflow, SSH, deploy, migration
remota e backfill de cliente real.

Base do trabalho: `PLANO_IMPLEMENTACAO_RAG_MULTIPROVIDER_2026-09-08.md` e o PDF
`Norma_Arquitetura_LLM_RAG_MultiProvider.pdf` (cinco páginas, lido integralmente).

| Repositório | Branch | HEAD antes | HEAD agora |
| --- | --- | --- | --- |
| LLM-backend | `feature/formatos-legados-doc-xls-pptx` | `3a1bd9a` | `109a82f` |
| Norman | `feature/finalizacao-camada-conhecimento` | `cfd7a57` | `2af225a` |

Nenhuma branch foi criada, trocada ou resetada. Os documentos não rastreados
(`PLANO_CONHECIMENTO_DE_IA.md`, `HANDOFF_OPUS_CONHECIMENTO_DE_IA.md`) continuam onde estavam.

---

## 1. Os três defeitos confirmados

### P0.1 — Consulta de descendentes gerava SQL inválido

**Reprodução.** A cláusula emitida era `... LIKE :prefix ESCAPE '\\'`, um escape de dois
caracteres. Reproduzido em PostgreSQL 18 com `standard_conforming_strings=on`: `22025 invalid
escape string`. Toda busca no cliente inteiro falhava, e o Norman traduzia a falha em lista vazia.

**Correção.** `starts_with(chunk.scope_path, :prefix)` no lugar do `LIKE`, com o prefixo tirado do
caminho já normalizado. Dispensa curinga e escape, então `%`, `_`, `[` e barra invertida no nome da
pasta passam a valer como texto.

**Evidência de regressão.** `src/documents/client-scope-search.integration.test.ts`, 9 casos contra
Postgres real: raiz e vários níveis, pasta irmã de nome parecido, caracteres especiais, outro
cliente com o mesmo caminho, cliente de id com prefixo igual, escopo inválido, normalização e
modelo de embedding. Com o código anterior, 8 dos 9 falham com `invalid escape string` — verificado
revertendo a correção antes de restaurá-la.

**Segunda metade.** `retrieveForFolder` e `retrieveForClient` passam a devolver
`{ snippets, unavailable, reason }`. Indisponibilidade vira um aviso explícito ao modelo, que manda
dizer que a consulta falhou em vez de afirmar ausência; o motivo técnico fica no log e não vai ao
provedor.

Arquivos: `src/documents/document-chunks.service.ts`, `server/modules/knowledge/knowledge.service.ts`,
`server/modules/ai/ai.service.ts`.

### P0.2 — Remoção não impedia o uso posterior da fonte

**Correção, em quatro frentes.**

1. **Corrida com o job.** Revogar é uma escrita condicional (`claimSource`) que avança a versão de
   processamento **antes** de qualquer chamada externa. O job que começou na versão anterior não
   consegue fechar; a gravação que ele já tinha feito no repositório é esquecida.
2. **Ressurreição por sincronização.** O caminho revogado vira lápide, e `rememberRepositoryFile`
   recusa reindexá-lo. O arquivo continua onde está — anexo compartilhado de projeto não é apagado.
3. **Derivados.** No LLM-backend, `forget-path` e `forget-prefix` marcam a nota do cliente com
   `stale_since` na mesma chamada, de forma durável. A marca vale mesmo com a fila fora do ar, e as
   rotas de dossiê e de visão do cliente deixam de servir nota marcada.
4. **Sucesso honesto.** A remoção guarda o estado da invalidação (`pending`, `confirmed`, `failed`)
   e a rota responde 202 enquanto ela não fecha. Repetir a remoção tenta invalidar de novo.

**Evidência.** `ai-knowledge.service.test.ts` (remoção antes da tarefa, remoção durante a
transcrição, job que já gravou e perde a corrida, falha de invalidação, repetição, idempotência,
listagem que não transiciona fonte revogada, retry recusado em fonte revogada);
`src/ingestion/internal-documents.controller.test.ts`; `src/knowledge/note-staleness.integration.test.ts`
(6 casos contra Postgres real).

### P0.3 — Áudio com falha não podia ser reenviado

**Correção.** A deduplicação passa pelo ciclo de vida: `failed` e transcrição parada além do limite
retomam a mesma fonte de forma idempotente; fonte pronta ou em curso não vira trabalho novo; fonte
revogada não revive implicitamente (o reenvio cria fonte nova). Dois reenvios simultâneos disputam
a versão e só um retoma. O nome do arquivo de transcrição carrega a identidade da fonte, então dois
áudios diferentes chamados `reuniao.ogg` não se sobrescrevem. Conflito no índice único de criação é
tratado reaproveitando a fonte que venceu.

**Evidência.** Bloco "P0.3 — áudio com falha pode ser reenviado" em `ai-knowledge.service.test.ts`,
8 casos.

---

## 2. Decisão arquitetural e contratos

`docs/decisao-gateway-ia-multiprovedor.md` (Norman) registra a mudança antes da migração: a
**execução** da geração passa ao backend de IA; o **plano de controle** (conexões, revisões, teste,
ativação com compare-and-swap, trava) continua no Norman. Inclui a tabela de responsabilidade pelos
dados, a regra de invalidação e vigência, a ordem de migração e o rollback.

### Contrato interno de geração, versão 1

`POST /internal/generation/v1/complete`. Carrega versão, correlação, operação de uma lista fechada,
identidade autorizada, cliente e escopo quando aplicável, a ativação com a revisão imutável,
mensagens e parâmetros permitidos.

O que **não** existe no contrato é parte dele: não há URL, segredo, prompt de sistema nem nome de
conexão livre. O `ValidationPipe` global roda com `forbidNonWhitelisted`, então campo a mais derruba
a requisição; mensagem com papel `system` é recusada. O prompt privilegiado sai do registro de
operações do backend.

`GET /internal/generation/capabilities` declara a versão do contrato, as operações da aplicação que
chamou, as causas elegíveis de fallback, as capacidades do provedor e as conexões — cada uma
disponível ou indisponível com o nome da variável que falta.

### Compatibilidade entre as versões

- Todo campo novo de resposta é aditivo. O adapter do Norman deduz o estado antigo quando o campo
  não vem, o que permite subir o Norman contra um LLM-backend anterior.
- A geração escolhe o caminho por `AI_GENERATION_PATH`, e o padrão é `legacy`. Subir esta versão sem
  mexer no ambiente não muda quem orquestra.
- Pedir `gateway` sem `LLM_BACKEND_URL` ou `INTERNAL_API_TOKEN` **não** cai para o legado em
  silêncio: a resolução volta com o motivo, que vai para o log da subida.

---

## 3. O que foi implementado

### Gateway no backend de IA (`src/gateway/`)

- `provider-connection.ts`: allowlist de conexões por chave, cada uma lendo a própria variável.
  Valida a URL base e recusa credencial embutida, query e protocolo fora de http/https. Ausência de
  configuração é indisponibilidade nomeada, nunca sucesso. Allowlist de modelos por conexão.
- `openai-chat.adapter.ts`: transporte compartilhado pelos provedores compatíveis, com timeout,
  cancelamento, uso de tokens e classificação de falha por tipo.
- `feature-registry.ts`: as operações aceitas e o prompt privilegiado de cada uma, com as regras de
  isolamento, de ausência e de tratar documento como dado, não instrução.
- `fallback-policy.ts`: desligado por padrão. Autorização, payload inválido, configuração inválida e
  cancelamento nunca autorizam troca — nem se o administrador as listar. Stream já entregue não
  troca no meio.
- `generation.service.ts`: contexto (dossiê + trechos com procedência + avisos), chamada, fallback e
  registro. `generation_executions` guarda uma linha por tentativa.

### Provedor e modelo (Norman)

Escolher um modelo cria a **revisão seguinte** da conexão em vez de alterar a linha existente: o
teste aprovado da revisão anterior não vale para ela, e a ativação em curso continua na antiga até
alguém testar e ativar a nova. A escolha é limitada aos modelos provisionados. O fallback é
declarado com conexão alternativa provisionada, causas explícitas e limite de tentativas, num
histórico imutável com quem mudou e por quê.

A tela deixou de prometer troca imediata: informa o prazo de propagação, calculado do próprio cache
de cinco segundos do retrato.

### Contexto único e citações

A transformação final em briefing (depois do `BRIEFING_READY`) e a extração de briefing de documento
passaram a receber o mesmo contexto autorizado do chat, entregue como mensagem de sistema separada —
a descrição continua sendo o que o usuário disse. Cada trecho entra no prompt com o arquivo e, quando
o formato tem, a página. Campo ausente é omitido: página inventada em planilha é pior que página
nenhuma.

A recuperação aplica orçamento de contexto configurável (piso de similaridade, teto de caracteres e
de trechos) e devolve a evidência: considerados, usados, descartados por relevância e por tamanho,
melhor similaridade e se havia evidência suficiente.

### Auditoria

Cada entrada de geração nomeia a operação, e as etapas seguintes herdam funcionalidade, cliente,
correlação e evidências pelo mesmo contexto assíncrono que já carregava o retrato do provedor. O
registro ganhou correlação, tentativa, de quem ela é alternativa, uso de tokens e as evidências.
Conteúdo de trecho, prompt, documento e transcrição **não** são gravados.

### Fontes unificadas e governança

`knowledge_sources` cobre documento, texto e áudio pelo mesmo ciclo de vida (hash, vigência, versão
de processamento, lápide). `knowledge_candidates` guarda o que foi sugerido em conversa ou output,
com origem, autor e cliente, no estado pendente; só quem tem `aiKnowledge.manage` aprova, rejeita ou
revoga, e cada decisão registra quem, quando e por quê. Aprovar promove a fonte oficial; falha ao
promover mantém o candidato pendente, e falha ao revogar mantém a aprovação.

A consulta ao cliente inteiro deixou de alcançar `02_Briefings`, onde ficam os anexos que usuários
comuns enviam ao criar projeto. O anexo continua servindo à conversa daquele projeto.

**Não há aprovação automática nesta entrega.**

### Tela administrativa

As notas mostram o conteúdo, campo por campo, com tipo, modelo, versão do gerador e data. Os estados
aparecem distintos: fonte retirada, exclusão com invalidação pendente, invalidação que falhou (com
motivo e botão de repetir), falha, dossiê vigente, fora de circulação, ausente e acervo inacessível.
A aba ganhou o registro de conhecimento em texto e a fila de candidatos com aprovar, rejeitar e
revogar. O teste de tela monta o componente e exercita permissão, ações, erros e outputs.

### Reuso por outra aplicação (Niprofe)

As rotas internas reconhecem qual aplicação chamou, pelo token. O Norman vem do
`INTERNAL_API_TOKEN`, com as operações do produto e o escopo de cliente; outra aplicação entra por
`INTERNAL_CONSUMERS` declarando as próprias operações e o próprio escopo. Aplicação nova não herda
nada, e sem `client` entre os escopos não alcança conhecimento de cliente — é o que mantém intacto o
isolamento de pessoa e organização deste backend. Testado com um consumidor fictício.

O que existe de multimodal é declarado como é: descrição de imagem existe e serve ao OCR da
ingestão, **não** está aberta a consumidor; a revisão ortográfica de arte que o PDF menciona para o
Niprofe continua fora do contrato.

### Formatos legados

`src/ingestion/legacy-formats.integration.test.ts` leva DOC, XLS e PPTX **reais** do arquivo até a
citação: extração com a origem certa, chunk, gravação no Postgres, recuperação com arquivo, caminho
e chunk. A paginação de cada formato é conferida como ela é. Formato não suportado e arquivo
corrompido falham em vez de entrar vazios no acervo.

### Operação

`deploy/OPERACAO.md` reúne ambientes, variáveis por assunto (sem nenhum valor de segredo), ordem de
publicação, rollback, saúde, filas, onde cada falha aparece e a tabela do que vale alertar.

A retenção ganhou variável por sujeito e **nenhum padrão**: prazo é decisão de quem responde pelos
dados. Enquanto não houver decisão, `GET /health` lista o sujeito em `retention.pendingDecision`.
A rota diz o que já foi decidido sem expor o prazo, porque é aberta.

---

## 4. Migrations criadas (locais, não aplicadas em banco remoto)

### LLM-backend (TypeORM)

| Arquivo | O que faz |
| --- | --- |
| `1757300000000-KnowledgeNoteStaleness.ts` | `stale_since` e `stale_reason` em `knowledge_notes`, com índice parcial |
| `1757400000000-GenerationExecutions.ts` | tabela `generation_executions` |

### Norman (SQL)

| Arquivo | O que faz |
| --- | --- |
| `0016_knowledge_source_lifecycle.sql` | `processing_version`, `revoked_at`, `revocation_state`, `revocation_reason` |
| `0017_ai_request_correlation.sql` | `correlation_id`, `attempt`, `fallback_of`, tokens e `evidence` |
| `0018_ai_model_selection_and_fallback.sql` | `selected_model`, `allowed_models_env`, autoria da revisão, tabela `ai_fallback_policies` |
| `0019_knowledge_candidates.sql` | tabela `knowledge_candidates` |

**Compatibilidade.** Todas são aditivas: colunas novas são opcionais ou têm default, e as tabelas
novas não são lidas pela versão anterior do código. Subir o schema antes do código é seguro.

**Rollback.** Trocar `AI_GENERATION_PATH` de volta para `legacy` e reiniciar reverte a migração da
geração sem tocar no banco. Para voltar de versão, `git reset --hard` na tag anterior e repetir o
`deploy.sh`; as migrations do LLM-backend têm `down`, mas o caminho preferido é manter o schema.

**Verificação.** As quatro migrations do Norman foram aplicadas contra um PostgreSQL 18 descartável
(embarcado), duas vezes cada, confirmando que aplicam e são idempotentes, e que as colunas e tabelas
esperadas existem depois. Nenhum banco compartilhado foi tocado.

---

## 5. Comandos executados e resultados

### LLM-backend

| Comando | Resultado |
| --- | --- |
| `npx tsc --noEmit` | passou |
| `npm run build` | passou |
| `npm test` | **493 passaram, 16 ignorados**, 37 arquivos |
| `git diff --check` | limpo |

Antes desta entrega: 299 passaram e 22 ignorados.

### Norman

| Comando | Resultado |
| --- | --- |
| `npm run check` | passou |
| `npm run check:server` | passou |
| `npm run build` | passou |
| `npm test` | **10 629 passaram, 4 ignorados**, 442 arquivos |
| `npm run test:coverage` | statements 99,04% · branches 93,69% · functions 98,55% · lines 99,60% |
| `git diff --check` | limpo |

Os pisos de cobertura (99,0 / 93,6 / 98,5 / 99,6) foram **preservados** e não reduzidos. Antes desta
entrega: 10 338 testes.

### Infraestrutura usada nos testes

Não há PostgreSQL, Redis, Docker nem Ollama nesta máquina. Para não deixar a prova em dublê, a suíte
do LLM-backend passou a subir um **PostgreSQL 18 embarcado com pgvector** e a falar com ele pelo
protocolo de fio, rodando as migrations de verdade (`src/test/embedded-postgres.ts`). Isso é
Postgres real, não simulação de SQL. `INGESTION_IT_DATABASE` continua apontando para um Postgres
externo quando existir.

Com isso, a suíte de isolamento por cliente deixou de usar o query builder falso — aquele que
escondeu o SQL inválido — e passou a exercitar a consulta que o TypeORM emite.

### Integrações ignoradas, com o motivo e o comando que falta

| Suíte | Motivo | Como executar |
| --- | --- | --- |
| `src/ingestion/ingestion.processor.integration.test.ts` (7) | exige Ollama para embeddings e visão | `INGESTION_IT_DATABASE=<banco descartável> OLLAMA_HOST=<host> npm test -- src/ingestion/ingestion.processor.integration.test.ts` |
| `src/knowledge/knowledge.processor.integration.test.ts` (9) | exige Ollama para estudo e dossiê | `KNOWLEDGE_IT_DATABASE=<banco descartável> OLLAMA_HOST=<host> npm test -- src/knowledge/knowledge.processor.integration.test.ts` |
| `server/modules/knowledge/knowledge-backfill.integration.test.ts` (4, Norman) | exige Postgres real via `DATABASE_URL` | `KNOWLEDGE_BACKFILL_IT=1 DATABASE_URL=<banco descartável> npm test -- server/modules/knowledge/knowledge-backfill.integration.test.ts` |

**Nada aqui foi contado como aceite.** Nenhum provedor externo real foi chamado: OpenAI e Grok não
têm credencial nesta máquina, e o Ollama não está instalado. Os adapters foram exercitados por
contrato — status, classificação de falha, timeout, cancelamento, uso de tokens —, não contra o
serviço remoto.

---

## 6. Hashes dos commits locais

### LLM-backend (`feature/formatos-legados-doc-xls-pptx`)

| Hash | Assunto |
| --- | --- |
| `83403cf` | consulta de descendentes valida no Postgres e prova em banco real |
| `6cedf3a` | tirar o dossiê de circulação junto com o documento removido |
| `3bad795` | procedência por trecho, orçamento de contexto e critério de evidência |
| `2ef116f` | orquestração de geração no backend de IA, com contrato interno versionado |
| `8eb0d23` | pastas que ficam fora da consulta ao cliente inteiro |
| `e60e990` | contrato por aplicação, capacidades declaradas e formatos legados ponta a ponta |
| `109a82f` | política de retenção visível e documentação de operação |

### Norman (`feature/finalizacao-camada-conhecimento`)

| Hash | Assunto |
| --- | --- |
| `0601772` | separar acervo vazio de acervo indisponível |
| `30571c9` | vigência da fonte e reenvio de áudio recuperável |
| `24a3081` | dossiê fora de circulação não apaga os tokens de marca |
| `5e63dd9` | registrar a decisão de mover a orquestração para o backend de IA |
| `ebd6baf` | mesmo contexto autorizado em toda geração, e auditoria que diz o que atendeu |
| `4953216` | trechos com origem no prompt e evidências na auditoria |
| `4bd53e5` | caminho de geração pelo gateway, com o legado como rollback |
| `bd8f7ff` | escolha administrativa de modelo por revisão e fallback declarado |
| `6cf36a8` | conhecimento candidato com aprovação administrativa |
| `f453ee9` | tela mostra o conteúdo dos outputs e distingue os estados |
| `2af225a` | a tela deixa de prometer troca de provedor imediata |

Autor e committer: `Diego Alípio Abenicio <admin@ptwag.com>` no LLM-backend e
`Diego Abenicio <admin@ptwag.com>` no Norman, conforme o nome configurado em cada repositório.
Nenhuma mensagem cita assistente, modelo ou bot.

---

## 7. Pendências

### Decisão de negócio

- **Prazo de retenção** dos quatro sujeitos. A configuração existe, o padrão não, e a pendência
  aparece em `/health`. Enquanto não for decidida, não há descarte automático.
- **Política de fallback**: ligar significa mandar dados do cliente a outro fornecedor. A decisão é
  do administrador e fica registrada; nada foi ligado.
- **Promoção do acervo antigo**: nenhum documento já existente foi promovido a conhecimento oficial
  por migração genérica. O inventário para decisão posterior é a própria listagem de candidatos.

### Credenciais e provedores

- OpenAI e Grok não têm chave nesta máquina. As conexões aparecem como indisponíveis, com a variável
  que falta. **Teste real de provedor externo continua pendente**, e nada foi simulado como aceite.
- Garantia contratual de não treinamento pelos fornecedores externos depende da conta, da
  configuração e dos termos aplicáveis. Nenhum parâmetro de código substitui essa verificação.

### Infraestrutura

- Separação efetiva das VPS, restrição dos endpoints expostos e autenticação do Redis: etapa
  operacional autorizada, não executada.
- Reindexação por troca de modelo de embedding: preparada pelo filtro de procedência por chunk, não
  automatizada. Trocar `OLLAMA_EMBEDDING_MODEL` faz a busca ignorar os vetores antigos.
- Streaming pelo gateway: o adapter declara `streaming: false` e as entradas em streaming pedem a
  resposta inteira. Implementar streaming de verdade é trabalho pendente.

### Migração da geração

- O **texto dos prompts de produção** continua no caminho legado. O registro de operações do gateway
  tem os prompts que ele serve, e mover o texto de produção para lá faz parte da etapa de publicação,
  junto com o aceite em dev — mover agora mudaria o comportamento de produção sem aceite.

### Niprofe

- O contrato por aplicação existe, é autenticado, declara capacidades e é testado com consumidor
  fictício. Ligar o produto de verdade depende do repositório e do contrato dele, que não estão em
  escopo. Nenhum terceiro projeto foi editado.

---

## 8. Roteiro de publicação e aceite (não executado)

1. Revisar os commits das duas branches.
2. Publicar o **backend de IA primeiro**, com `./deploy/deploy.sh --check` antes do `deploy.sh`. As
   migrations do TypeORM entram no passo 3 do script.
3. Aplicar as migrations do Norman (`npm run db:migrate`) e publicar o Norman, ainda com
   `AI_GENERATION_PATH=legacy`. Nada muda de comportamento: as respostas novas são aditivas.
4. Conferir `GET /internal/generation/capabilities` no ambiente: versão do contrato, conexões
   disponíveis e o motivo de cada indisponibilidade.
5. Só então virar `AI_GENERATION_PATH=gateway` em dev e reiniciar. Rollback é voltar a variável.
6. Rodar o aceite em dev com dois clientes sintéticos:
   - upload real pela tela, extração e transcrição;
   - notas visíveis com conteúdo, dossiê e tokens;
   - resposta citando o arquivo de origem;
   - isolamento negativo com o marcador `ORQUIDEA CROMADA 47` e a cor `azul-cobalto`, no cliente A e
     no cliente B, também nos formatos legados e no áudio — não só no `knowledge-layer-test.pdf`;
   - exclusão de fonte e checagem de que a resposta seguinte não a usa;
   - troca de provedor e de modelo, com o teste exigido antes da ativação.
7. Se o marcador de um cliente aparecer no outro: **interromper o aceite**, preservar as evidências
   sem segredos e reportar antes de qualquer ajuste de prompt.

Este trabalho está **implementado e verificado localmente**. Não está liberado: push, deploy e
aceite nos ambientes permanecem fora da autorização de quem executou.
