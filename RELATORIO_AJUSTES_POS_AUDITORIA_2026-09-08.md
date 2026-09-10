# Relatório dos ajustes pós-auditoria — RAG, conhecimento de IA e multiprovedor

**Data:** 08/09/2026, com a rodada de consistência de provedores e a rodada de
bordas de integração em 09/09/2026
**Origem:** `AJUSTES_POS_AUDITORIA_RAG_MULTIPROVIDER_2026-09-08.md`,
`CORRECOES_FINAIS_E_SQUASH_RAG_MULTIPROVIDER_2026-09-08.md`,
`CORRECAO_FINAL_CONSISTENCIA_PROVEDORES_2026-09-08.md` e
`CORRECAO_BORDAS_INTEGRACAO_GATEWAY_2026-09-09.md`
**Estado:** implementação local, sem publicação. Há bloqueios externos abertos (§7).

Este relatório não usa "concluído" nem "pronto para produção": as dependências
externas de §7 continuam sem verificação possível nesta máquina, e uma delas — o
teste de conexão contra um provedor real — é justamente o que fecharia o aceite
do multiprovedor.

A rodada de correções finais fechou doze defeitos que a implementação anterior
tinha deixado passar, incluindo quatro que este mesmo relatório afirmava
resolvidos. As afirmações contraditadas estão retificadas em §1, com o texto
antigo citado onde ele estava errado.

A rodada de 09/09/2026 fechou os dois defeitos de consistência que restavam —
ativação distribuída (P0.9) e fallback fixado na revisão testada (P0.10) —, ambos
descritos em §1 com a arquitetura escolhida, o comportamento de recuperação e a
evidência de cada teste exigido. Ela **retifica** o que P0.2 desta mesma versão
afirmava: a ativação era verificada no executor, mas era gravada no Norman
**antes** de ele confirmá-la, e a identidade ficava num campo sobrescrevível da
revisão. As duas coisas estão corrigidas, e o texto antigo está citado em P0.9.

A segunda rodada de 09/09/2026 — a de bordas de integração — fechou dois defeitos
que **as duas suítes isoladas não podiam encontrar**, porque cada lado estava
correto sozinho e a incompatibilidade só existia entre eles: o token do Norman
não estava autorizado nas operações genéricas que o próprio adapter dele produz
(P0.11), e a trava operacional fabricava uma identidade de ativação que o
executor, agora que valida toda geração, recusa (P0.12). Os dois estão descritos
em §1. A causa comum é a mesma, e está registrada aqui porque ela é o que a
correção precisa impedir de repetir: **não havia nenhum teste com os dois
processos reais conversando**, e cada suíte confirmava a metade que era sua. A
suíte de contrato criada nesta rodada (§3) é a resposta a isso — ela derruba os
dois defeitos quando qualquer um deles é reintroduzido, o que foi verificado
revertendo cada correção e observando a suíte falhar.

---

## 1. Requisito → arquivos → testes → evidência

### P0.1 — Provedor externo sem segredo duplicado no Norman

| | |
| --- | --- |
| **Defeito** | O teste da conexão já acontecia no LLM-backend, mas ativação, seleção de modelo e visão administrativa continuavam resolvendo a conexão pelo ambiente **do Norman**. Grok e OpenAI só podiam ser ativados se chave, URL, modelo e allowlist existissem também lá. |
| **Retificação** | A versão anterior deste relatório afirmava, em P0.6: *"As chaves de provedor continuam necessárias no Norman enquanto o caminho legado for o padrão e o rollback."* Isso está **errado** e foi corrigido: o legado passou a ter configuração própria e independente, e as chaves de provedor externo saíram do Norman sem desligar o rollback. |
| **Arquivos** | Norman: `ai-provider-control/ai-provider-control.service.ts` (metadados do executor no lugar do ambiente), `ai/ai-adapter.factory.ts` (`resolveExecutorControlPlane`), `ai/llm-gateway.client.ts` (`syncRevision`, `activateRevision`), `ai/text-provider.ts` (reescrito como caminho legado isolado), `gemini.ts`, `bootstrap/module-composition.ts`, `scripts/check-ai-generation-readiness.ts`, `.env.example`, `client/src/features/ai-knowledge/{ai-provider.api.ts,ai-knowledge-screen.tsx}`. Backend: `gateway/internal-generation.controller.ts` (revisões nas capacidades), `.env.example`, `OPERACAO_GATEWAY_E_CONHECIMENTO.md`. |
| **Testes** | `ai-provider-control.service.test.ts` (bloco "fronteira de segredo entre o Norman e o executor": 8), `text-provider.test.ts` (reescrito: 9), `ai-adapter.factory.executor.test.ts` (6), `llm-gateway.client.test.ts` (6), `gemini.completions.test.ts` (reescrito para o legado), `ai-knowledge-screen.test.tsx` (4). |
| **Evidência** | Com Grok provisionado **só** no LLM-backend e com `SEM_CHAVE_NENHUMA` no ambiente do Norman, a conexão aparece pronta, é testável, tem modelo escolhível e é ativável. `resolveTextProvider` não lê `GROK_API_KEY`, `OPENAI_API_KEY` nem `GROK_MODEL` — há teste parametrizado provando que nenhum desses valores atravessa. A chave não aparece em `overview()` nem nos metadados de capacidades. O rollback legado aponta para o Ollama local por `LEGACY_AI_*`, com padrões utilizáveis: sem variável nenhuma ele funciona. |

### P0.2 — Revisão e ativação verificadas, não apenas auditadas

| | |
| --- | --- |
| **Defeito** | O LLM-backend recebia `activationId` e `connectionRevision` mas executava por `connectionKey` e modelo permitido. Revisão inexistente, antiga ou incompatível era aceita, e `activationId` era um campo que qualquer corpo podia inventar. |
| **Retificação (09/09/2026)** | Este item ficou pela metade. A verificação passou a existir, mas a **ativação em si** continuava sendo gravada no Norman antes de o executor confirmá-la, e a identidade morava num campo sobrescrevível da revisão (`connection_revisions.activation_id`), que uma tentativa posterior apagava. Ver P0.9, que fecha os dois defeitos com um protocolo de preparação, confirmação e reconciliação. O trecho *"a geração recusa **antes do provedor**: [...] sem ativação registrada"* continua verdadeiro, e ficou mais forte: a autorização passou a consultar `connection_activations`. |
| **Arquivos** | Backend: `database/migrations/1757600000000-ConnectionRevisions.ts`, `gateway/connection-revision.entity.ts`, `gateway/connection-revisions.service.ts`, `gateway/connection-test.service.ts`, `gateway/generation.service.ts`, `gateway/generation.dto.ts`, `gateway/internal-generation.controller.ts`, `gateway/gateway.module.ts`. Norman: `ai/llm-gateway.client.ts`, `ai-provider-control/ai-provider-control.service.ts`, `scripts/check-ai-generation-readiness.ts`. |
| **Testes** | `src/gateway/connection-revisions.service.test.ts` (20, Postgres embarcado), `generation.service.test.ts` (6 novos), `connection-test.service.test.ts` (reescrito: 9), `server/modules/ai/revision-contract.integration.test.ts` (8, contrato das duas pontas por HTTP real). |
| **Evidência** | O registro vincula de forma imutável chave + revisão + modelo + digest do provisionamento. Sincronizar de novo os mesmos valores é idempotente; a mesma revisão com outro modelo é recusada. A geração recusa **antes do provedor**: revisão inexistente, desabilitada, de outra conexão, com modelo divergente, sem ativação registrada ou com `activationId` diferente do gravado. Revisão 2 executa com o modelo dela (`llama-grande`), não com o da revisão 1. Mudar o provisionamento muda o digest e invalida a revisão aprovada. O registro de execução aponta para a revisão realmente resolvida — inclusive quando o fallback troca de conexão. |

### P0.3 — Persistência do áudio antes do sucesso

| | |
| --- | --- |
| **Defeito** | `storeAudio` capturava a falha do storage, devolvia a fonte sem caminho e o upload respondia sucesso. Reiniciar o processo perdia o áudio sem ninguém saber. |
| **Retificação** | A versão anterior afirmava, em P1.2: *"O arquivo é guardado **antes** de a resposta sair."* Guardado sim, mas a **falha** em guardá-lo não impedia o aceite — que é o defeito. |
| **Arquivos** | Norman: `ai-knowledge/ai-knowledge.service.ts` (`storeAudio`, `markUnstored`, `scheduleTranscription`). |
| **Testes** | `ai-knowledge.service.test.ts`, bloco "persistência antes do aceite" (6). |
| **Evidência** | Storage indisponível responde `503 AUDIO_STORAGE_UNAVAILABLE` e **não** retorna sucesso. Sem armazenamento durável configurado, o envio também não é aceito. Nenhuma transcrição é agendada quando a persistência falha (`tarefas` vazio, `transcribeAudio` não chamado). A fonte fica `failed`, com motivo seguro, sem caminho de áudio e sem trabalho agendado — e o motivo não carrega o endereço interno do storage. Storage que confirma sem o banco registrar também não vira aceite. Falha ao **agendar**, já com o áudio guardado, mantém a fonte em `received` para o worker retomá-la. |

### P0.4 — Claim, lease e recuperação sem transcrição duplicada

| | |
| --- | --- |
| **Defeito** | O worker listava qualquer fonte em `received` ou `transcribing` a cada minuto. Uma transcrição ativa era reclamada, a versão avançava e o trabalho recomeçava — em chamada longa, a cada ciclo. |
| **Arquivos** | Norman: `migrations/0023_knowledge_audio_lease.sql`, `shared/schema.ts`, `ai-knowledge/ai-knowledge.{types,repository,service}.ts`, `bootstrap/module-composition.ts` (`workerId` por processo). |
| **Testes** | `ai-knowledge.service.test.ts`, blocos "arrendamento da transcrição" (5) e "backoff e limite de tentativas" (5), mais "bordas do arrendamento" (3); `ai-knowledge.repository.test.ts` (5). |
| **Evidência** | A tomada é uma instrução só, condicional à versão de processamento **e** ao arrendamento vencido. Duas réplicas concorrentes produzem **uma** chamada de transcrição (`primeira + segunda === 1`). Worker rodando antes do vencimento não reclama a fonte. Depois de simular queda e vencer o lease, outra instância retoma e passa a ser a dona. Transcrição que atravessa três minutos de relógio não é reiniciada: o lease é renovado a cada minuto enquanto a chamada está viva. O trabalho carrega só o identificador; os bytes vêm do storage (`storage.read` chamado com o caminho). Falha marca `next_attempt_at` no futuro, solta o arrendamento e respeita o backoff exponencial com teto; esgotadas as tentativas, a fonte para de voltar sozinha e continua reprocessável a pedido. |

### P0.5 — Cancelamento observado na conexão de resposta

| | |
| --- | --- |
| **Defeito** | Os dois lados observavam `close` na **requisição**. Em Node esse evento ocorre quando o corpo da requisição terminou de ser lido, o que acontece em toda chamada normal. O teste anterior disparava o evento na mão e não provava conexão HTTP nenhuma. |
| **Retificação** | A versão anterior afirmava, em P0.5: *"Cancelar aborta o `signal` que chegou ao `fetch`."* O sinal chegava, mas a origem dele estava errada. |
| **Arquivos** | Backend: `gateway/internal-generation.controller.ts`. Norman: `ai/ai.routes.ts` (`cancellationOf` devolvendo `signal` e `settle`). |
| **Testes** | `src/gateway/stream-cancellation.integration.test.ts` (3, servidor HTTP real), `server/modules/ai/ai.stream-cancellation.integration.test.ts` (3, servidor HTTP real), `ai.routes.test.ts` (6). |
| **Evidência** | Com servidor HTTP de verdade: o cliente abre o streaming, lê um delta e fecha o socket; o `fetch` do provedor observa `signal.aborted === true`. Requisição normal **não** é cancelada só porque o corpo terminou — há teste explícito de que `req.on("close")` não aborta. Conclusão normal não é registrada como cancelamento: `res` também emite `close` depois do `end()`, e a trava de conclusão impede que isso conte como abandono. Os ouvintes são soltos ao fim (`listenerCount === 0`), porque um socket keep-alive atende várias respostas. O cancelamento é uma falha própria (`failureKind: "cancelled"`), distinta de timeout e de erro do provedor. |

### P0.6 — Operação genérica e operação por cliente, separadas

| | |
| --- | --- |
| **Defeito** | Todas as features ficaram com `clientBinding: "optional"`. Uma tela por cliente que deixasse de mandar `clientId` era atendida em modo genérico: o gateway respondia sem conhecimento nenhum e o defeito de transporte não aparecia em lugar nenhum. |
| **Retificação** | A versão anterior registrava isso como *"diferença deliberada"*: *"Nenhuma feature está marcada `clientBinding: 'required'`."* A intenção — permitir a conversa antes da escolha do cliente — era legítima, mas a solução estava errada: o modo genérico virou operação própria, e a vinculada passou a ser obrigatória. |
| **Arquivos** | Backend: `gateway/feature-registry.ts` (`ClientBinding` sem `optional`, seis pares de operação, prompt `SEM_CLIENTE`), `gateway/generation.service.ts`. Norman: `ai/llm-gateway.client.ts` (`GENERIC_FEATURE`), `ai/gateway-ai.adapter.ts`, `ai/ai.routes.ts` (recusa de escopo com o status dela), `knowledge/chat-knowledge-scope.ts` (403 em vez de indefinido), `client/src/features/projects/new-project/new-project-screen.tsx`. |
| **Testes** | `feature-registry.test.ts` (4 novos), `prompt-parity.test.ts` (3), `generation.service.test.ts` (3), `gateway-ai.adapter.test.ts` (6), `ai.routes.test.ts` (9), `chat-knowledge-scope.test.ts` (4), `new-project-screen.test.tsx` (2). |
| **Evidência** | `optional` deixou de existir: toda operação é `none` ou `required`, e há teste que percorre o registro inteiro. Cada operação vinculada tem contraparte genérica declarada, com nome distinto — é o nome que separa os dois modos na auditoria, e há teste provando que `chat_generic`/`clientId: null` e `chat`/`clientId` ficam distinguíveis no registro de execução. O fluxo genérico antes da escolha continua funcionando, sem acervo e dizendo isso no prompt. Fluxo por cliente sem `clientId` falha visivelmente (`exige cliente`), e o provedor não é chamado. `clientId` não autorizado responde **403**, com código próprio, e não uma resposta genérica — em `/api/ai/chat`, `/api/ai/chat/stream`, `/api/ai/briefing`, `/api/ai/workflow-briefing/*` e `/api/ai/extract-document`. A tela declara em qual modo está e nomeia o cliente quando há um. |

### P0.7 — Upload de documentos dentro de Conhecimento de IA

| | |
| --- | --- |
| **Defeito** | A aba administrativa aceitava áudio e texto; documento tinha de ser enviado por outra tela. Não havia upload nem substituição no lugar em que o administrador gerencia o conhecimento. |
| **Arquivos** | Norman: `ai-knowledge/ai-knowledge.service.ts` (`addDocumentSource`), `ai-knowledge/ai-knowledge.routes.ts` (`POST .../document-sources`, `GET .../document-formats`), `client/src/features/ai-knowledge/{ai-knowledge.api.ts,ai-provider.queries.ts,ai-knowledge-screen.tsx}`. |
| **Testes** | `ai-knowledge.service.test.ts` (14), `ai-knowledge.routes.test.ts` (12), `legacy-formats-upload.integration.test.ts` (11, multipart e HTTP reais), `ai-knowledge-screen.test.tsx` (8), `ai-knowledge.api.test.ts` (3), `ai-provider.queries.test.ts` (3). |
| **Evidência** | O administrador envia PDF, DOC, DOCX, XLS, XLSX, XLSM e PPTX sem sair da aba, e o arquivo vai para a pasta canônica `Conhecimentos gerais do cliente` do cliente selecionado. Com multipart real contra servidor HTTP real, cada formato chega **byte a byte** ao repositório e ganha ficha `kind: "document"`, `status: "studying"`. Usuário sem `aiKnowledge.manage` não vê o controle nem consegue chamar a rota. O documento aparece na lista de fontes. Nova versão preserva a anterior fora de vigência, com `revocationReason` contendo "substituída por uma versão nova" e o mesmo `assetPath`. O cliente vem do caminho: mandar outro no corpo dá 403. Vários arquivos por envio, com limite explícito de quantidade e tamanho declarado pela rota e mostrado na tela. Áudio é recusado nesta rota, mesmo com bytes de áudio reais. |

### P0.8 — Excel atravessando todas as entradas do Norman

| | |
| --- | --- |
| **Defeito** | `/api/ai/extract-document` aceitava Word e PowerPoint, não continha MIME types de Excel, e anunciava uma lista de formatos incompatível com o extrator real (`PPT`, que o backend não lê). |
| **Arquivos** | Norman: `shared/knowledge-document-formats.ts` (decisão centralizada), `ai/ai.routes.ts`, `ai-knowledge/ai-knowledge.service.ts`, `client/src/features/projects/new-project/new-project-screen.tsx`. Backend: `ingestion/extraction/extracted-text.ts` (MIME do `.xlsm`, listas exportadas, `isSupportedDocument`). |
| **Testes** | `shared/knowledge-document-formats.test.ts` (30), `ai.routes.test.ts` (16), `ai-knowledge.service.test.ts` (12), `legacy-formats-upload.integration.test.ts` (11). |
| **Evidência** | A decisão de formato é uma só, em `shared/`, e é usada pela rota de extração, pela rota documental da aba e pelo `accept` das duas telas. `.xls`, `.xlsx` e `.xlsm` atravessam com seus MIME types e também com `application/octet-stream` quando a extensão é confiável — que é o caso normal de arquivo vindo do Drive e do Supabase. `.ppt` saiu do anúncio porque o extrator não o lê. A mensagem de recusa lista os formatos reais. Arquivo incompatível é recusado antes de qualquer processamento caro. |

### P1.1 — Byte NUL removido do fonte TypeScript

| | |
| --- | --- |
| **Defeito** | `server/modules/ai-knowledge/brand-tokens.ts` continha um byte NUL literal na chave de deduplicação. O TypeScript compilava, mas Git e ferramentas tratavam o arquivo como binário. |
| **Arquivos** | Norman: `ai-knowledge/brand-tokens.ts`. |
| **Testes** | `brand-tokens.test.ts` (5 novos, incluindo a leitura do próprio fonte). |
| **Evidência** | `file server/modules/ai-knowledge/brand-tokens.ts` responde `Java source, Unicode text, UTF-8 text` (antes: `data`). A contagem de bytes NUL é zero, verificada pelo próprio teste, que também decodifica o arquivo como UTF-8 estrito. O comportamento de deduplicação está preservado e coberto: o mesmo texto em tipos diferentes continua sendo tokens distintos, e um valor que colida com o nome de outro tipo não é deduplicado por engano. |

### P1.2 — Raiz do cliente cobrindo as grafias realmente armazenadas

| | |
| --- | --- |
| **Defeito** | A busca do cliente inteiro mandava uma única raiz presumida por `clientKnowledgeRoot`. Cliente com espaços, `&`, acentos ou underscores podia ter chunks sob outro alias e receber acervo vazio, sem erro nenhum. |
| **Retificação** | A versão anterior afirmava, em P0.1: *"A consulta sem pasta delega `scopePath: <raiz>`, `includeDescendants: true`."* Era exatamente esse caminho que falhava para essas grafias. |
| **Arquivos** | Backend: `documents/document-chunks.service.ts` (consulta por `clientId`, sem cláusula de caminho), `ingestion/internal-documents.dto.ts`, `gateway/generation.service.ts`. Norman: `knowledge/briefing-source-path.ts` (`clientKnowledgeRoots`), `knowledge/chat-knowledge-scope.ts`, `knowledge/knowledge.service.ts`, `knowledge/knowledge.port.ts`, `knowledge/llm-backend-knowledge.adapter.ts`, `ai/ai.service.ts`. |
| **Testes** | `client-scope-search.integration.test.ts` (4 novos, Postgres real), `document-chunks.service.test.ts` (4), `knowledge.service.test.ts` (5), `chat-knowledge-scope.test.ts` (3), `ai.service.test.ts` (3), `briefing-source-path.test.ts` (5), `llm-backend-knowledge.adapter.test.ts` (2). |
| **Evidência** | Contra Postgres real: `Jonson & Co` recupera chunks gravados tanto sob `Jonson & Co` quanto sob `Jonson___Co`, porque a trava passou a ser o `clientId` e a consulta geral não manda caminho nenhum. `Jonson_Co` de outro cliente **não** entra por aproximação. `02_Briefings` continua excluída em todas as grafias da raiz, e a consulta autorizada da própria pasta de briefings continua alcançando o anexo. Caminho já persistido não é re-sanitizado: `assetFolderName` entra cru, e só o nome de exibição é sanitizado — há teste provando que `Jonson___Co` não vira `Jonson_Co`. Caminho pedido que não normaliza (`..`) continua devolvendo vazio, e não vira consulta ao cliente inteiro. |

### P1.3 — Estado do documento acompanhando qualquer caminho oficial

| | |
| --- | --- |
| **Defeito** | `listSources` verificava o estudo apenas dentro de `<cliente>/Conhecimentos gerais do cliente`, mas `registerDocumentSource` registra documentos oficiais de outros caminhos. Esses documentos ficavam para sempre em `studying` na interface. |
| **Arquivos** | Norman: `ai-knowledge/ai-knowledge.service.ts` (`ingestionStateFor`, `parentFolderOf`, `safeIngestionFailure`), `knowledge/knowledge.port.ts`. Backend: `knowledge/knowledge-notes.service.ts` (motivo da falha no estado de escopo). |
| **Testes** | `ai-knowledge.service.test.ts` (9). |
| **Evidência** | A consulta segue o `assetPath` de cada fonte em estudo, uma por pasta encontrada. Documento em `01_Brand_Guide_Institucional` chega a `ready`; documento em `Conhecimentos gerais do cliente` também. Documento que falhou mostra `failed` com o motivo vindo do executor, cortado para não virar a ficha inteira; sem motivo declarado, a ficha ainda explica o que fazer. Um arquivo pronto não altera o estado de outro com nome semelhante em outra pasta — o casamento é pelo caminho inteiro. Consulta de estado que falha deixa a fonte como está, em vez de concluir o que não sabe. |

### P0.9 — Ativação distribuída consistente (preparação, confirmação, reconciliação)

| | |
| --- | --- |
| **Defeito** | Em `ai-provider-control.service.ts`, o Norman chamava `repository.activate()` **antes** de `activateRevisionAtExecutor()`. A primeira chamada já inseria a linha que `latestActivation()` considerava vigente. Falha remota depois disso fazia a rota responder erro com o banco daqui **já trocado**: a IA que atendia as pessoas mudava sem ninguém ter decidido, e os dois serviços ficavam divergentes. No LLM-backend, a identidade de ativação era um campo sobrescrevível da revisão (`connection_revisions.activation_id`): uma tentativa posterior gravava a identidade nova por cima e invalidava a ativação anterior, que ainda era a vigente do outro lado. |
| **Por que inverter as duas chamadas não resolve** | Um timeout na confirmação remota não diz se ela aconteceu. Confirmar primeiro e gravar depois só troca o lado que fica divergente. O que fecha o defeito é a identidade existir **antes** da chamada, o estado ser explícito, a confirmação remota ficar marcada de forma durável e haver reconciliação. |
| **Arquitetura escolhida** | Protocolo de três passos com estado durável. **Norman:** `ai_provider_activation_intents` (mutável) guarda a tentativa — `id` (que **é** o `activationId` que atravessa o contrato), conexão, chave, revisão, modelo, `expected_activation_id` (base do CAS), `state` (`pending`/`active`/`failed`/`cancelled`), `remote_confirmed_at` e `activation_id`. `ai_provider_activations` continua sendo o histórico imutável e só recebe linha **depois** da confirmação remota, com o **mesmo** identificador da tentativa. `latestActivation()` e `listActivations()` passaram a ler com junção às tentativas: linha cuja tentativa não está `active` não é vigente. **LLM-backend:** `connection_activations`, uma linha por identidade confirmada, com `activation_id` único e a tupla `(activation_id, connection_key, revision)` única; a autorização da geração passou a consultar essa tabela, e `connection_revisions.activation_id` ficou como coluna herdada, não reescrita e não consultada. |
| **Concorrência** | Índice único parcial `ai_provider_activation_intents_pending_idx` sobre `(state) WHERE state = 'pending'` — uma tentativa pendente por instalação. Índice único parcial `..._expected_idx` sobre `expected_activation_id WHERE state IN ('pending','active')` — uma vencedora por ativação observada, e uma tentativa que falhou libera a base para nova tentativa. Os dois somados ao `pg_advisory_xact_lock` da transação de preparação e ao índice único pré-existente de `previous_activation_id`. |
| **Recuperação e idempotência** | Recusa do executor (4xx) encerra a tentativa como `failed` e a ativação anterior segue vigente. Incerteza (timeout, queda de rede, 5xx) **mantém** a tentativa `pending` e responde `503 AI_PROVIDER_ACTIVATION_UNCONFIRMED`, sem invalidar cache. `reconcileActivations()` — chamada na abertura do panorama, no início de cada ativação e por `POST /api/admin/ai/providers/activations/reconcile` — resolve o pendente: com `remote_confirmed_at` gravado, repete a finalização (idempotente); sem ele, consulta `GET /internal/generation/connections/activations/{id}` no executor, onde **404 é ausência** de confirmação e qualquer outra falha é "não sei" e deixa a tentativa pendente. `markActivationConfirmed` preserva o instante da primeira marca; `commitActivation` devolve a ativação já criada quando repetido; a confirmação no executor é idempotente pela tupla e recusa a mesma identidade apontando para outra revisão. |
| **Cache** | `cached`/`executorCache` só são invalidados **depois** da finalização local. Há teste de que uma falha remota não derruba o cache. |
| **Arquivos** | Norman: `migrations/0024_ai_activation_protocol.sql`, `shared/schema.ts`, `ai-provider-control/{ai-provider-control.types.ts,ai-provider-control.repository.ts,ai-provider-control.service.ts,ai-provider-control.routes.ts,ai-provider-runtime.ts}`, `ai/{llm-gateway.client.ts,ai-adapter.factory.ts,gateway-ai.adapter.ts}`, `scripts/check-ai-generation-readiness.ts`, `server/test/embedded-postgres.ts`. LLM-backend: `database/migrations/1757700000000-ConnectionActivations.ts`, `gateway/{connection-activation.entity.ts,connection-revision.entity.ts,connection-revisions.service.ts,internal-generation.controller.ts,gateway.module.ts}`. |
| **Testes** | `server/modules/ai-provider-control/activation-protocol.integration.test.ts` (23, PostgreSQL embarcado com as migrations reais), `activation-protocol.migration.test.ts` (6, PostgreSQL embarcado), `server/modules/ai/activation-contract.integration.test.ts` (10, HTTP real + PostgreSQL embarcado, com resposta perdida depois da confirmação), `ai-provider-control.service.test.ts` (bloco "protocolo de ativação distribuída": 23), `ai-provider-control.repository.test.ts` (bloco de preparação/confirmação/finalização: 19), `ai-provider-control.routes.test.ts` (3), `llm-gateway.client.test.ts` (blocos `confirmActivation` e `describeActivation`: 14), `shared/schema.test.ts` (7), `src/gateway/connection-revisions.service.test.ts` (bloco "confirmação de ativação": 13), `src/gateway/internal-generation.controller.test.ts` (7), `src/database/connection-activations.migration.integration.test.ts` (5). |
| **Evidência dos casos exigidos** | (1) confirmação bem-sucedida torna a **mesma** identidade vigente nos dois lados — provado por HTTP real, comparando o `activationId` gravado no executor com o de `latestActivation()`. (2) Falha remota mantém a anterior vigente e `activeSnapshot()` devolvendo `act-inicial`. (3) Durante `pending`, `latestActivation()` e `activeSnapshot()` devolvem a anterior — inclusive com uma linha de ativação órfã inserida à mão, que a junção ignora. (4) Retry com a mesma identidade depois de timeout é idempotente: a repetição conclui a tentativa anterior e o executor continua com **uma** confirmação. (5) Confirmação remota seguida de falha na finalização local é reconciliada: a resposta é derrubada no meio (`socket.destroy()` depois de a confirmação estar gravada), a tentativa fica pendente, e `reconcileActivations()` a conclui. (6) Duas ativações concorrentes: só uma prepara e só uma confirma — no serviço, no repositório contra PostgreSQL real e por HTTP real. (7) Confirmar uma tentativa nova não apaga o vínculo anterior: as duas identidades continuam resolvendo. (8) e (9) A geração aceita somente identidade confirmada para a chave e a revisão informadas, e recusa **antes do adapter** identidade pendente, inventada, de outra revisão, de outra conexão ou confirmada sobre outro provisionamento. (10) As migrations sobem sobre banco vazio e sobre o estado produzido pelas migrations atuais, preservando as ativações que já existiam. |

### P0.10 — Fallback fixado na revisão testada

| | |
| --- | --- |
| **Defeito** | O Norman guardava na política uma `connectionId` (que já identifica uma revisão), mas `fallbackForGateway()` enviava **somente** `connectionKey`. O LLM-backend então resolvia com `latestEnabled(connectionKey)` — a revisão habilitada mais alta. Como uma revisão é sincronizada no executor **antes** de ser testada, o fallback podia executar exatamente a revisão não aprovada. Além disso, ligar o fallback não exigia teste recente e aprovado da revisão escolhida, e a comparação com o primário usava `connectionId`, o que permitia escolher outra revisão da **mesma chave lógica** como "alternativa". |
| **Contrato exato do fallback (versão 2)** | `fallback: { enabled: boolean, connectionKey: string, connectionRevision: number, model: string, allowedCauses: ("unavailable"\|"timeout"\|"rate_limited"\|"provider_error")[], maxAttempts: 2\|3 }`. Com `enabled: true`, `connectionKey`, `connectionRevision` e `model` são **obrigatórios** (`ValidateIf` no DTO) — política incompleta é recusada na validação, nunca resolvida por aproximação. Com `enabled: false`, nada além de `allowedCauses` e `maxAttempts` é exigido. |
| **Resolução no executor** | `latestEnabled()` foi **removido** do serviço. O fallback resolve pelo mesmo `ConnectionRevisionsService.require({ connectionKey, revision, model })` da geração primária, e recusa antes da chamada externa: revisão inexistente, desabilitada, de outra conexão, modelo divergente do registrado, modelo fora da allowlist ou digest de provisionamento alterado. `decideFallback` também recusa política sem revisão ou sem modelo, e alternativa de chave igual à do primário. |
| **Resolução no Norman** | A política grava `connection_revision` e `model` (colunas novas em `ai_fallback_policies`, histórico imutável). Ligar exige teste `passed` da **mesma** `connectionId` dentro de `CONNECTION_TEST_MAX_AGE_MS` (o mesmo prazo da ativação), e recusa `connection.key` igual à chave lógica do primário vigente (`AI_FALLBACK_SAME_CONNECTION_KEY`). `fallbackForGateway()` lê revisão e modelo da política — sem recalcular nada — e falha fechado quando a política é antiga (campos nulos), quando a revisão fixada divergiu da conexão gravada ou quando a chave passou a ser a do primário vigente. O modelo é fixado no momento da aprovação porque o padrão do executor pode mudar depois. |
| **Auditoria** | `GenerationAttemptReport` passou a carregar `connectionRevision`, e o resultado (inteiro e em fluxo) carrega `usedConnectionRevision`. `generation_executions.connection_revision` já existia e continua gravando a revisão realmente resolvida. No Norman, `recordRequest` grava `record.usedConnectionRevision` quando o executor o informa, em vez da revisão do retrato — que, com fallback, aponta para uma configuração que não executou nada. |
| **Compatibilidade de versão** | `GENERATION_CONTRACT_VERSION` e `GATEWAY_CONTRACT_VERSION` subiram para **2**. Publicação desencontrada falha explicitamente nos dois sentidos: backend novo recusa `contractVersion: 1`, backend antigo recusa `contractVersion: 2`. Nenhum dos dois escolhe revisão por aproximação. |
| **Arquivos** | LLM-backend: `gateway/{fallback-policy.ts,generation.dto.ts,generation.service.ts,generation-stream.contract.ts,connection-revisions.service.ts}`. Norman: `migrations/0024_ai_activation_protocol.sql`, `shared/schema.ts`, `ai-provider-control/{ai-provider-control.types.ts,ai-provider-control.repository.ts,ai-provider-control.service.ts}`, `ai/{llm-gateway.client.ts,gateway-ai.adapter.ts,ai-adapter.factory.ts}`. |
| **Testes** | `src/gateway/generation.service.test.ts` (bloco "fallback fixado na revisão aprovada": 11), `src/gateway/fallback-policy.test.ts` (4 novos), `src/gateway/generation.dto.test.ts` (6 novos), `ai-provider-control.service.test.ts` (bloco "revisão fixada": 11), `server/modules/ai/revision-contract.integration.test.ts` (bloco "contrato do fallback fixado na revisão": 5, HTTP real), `activation-protocol.integration.test.ts` (2, PostgreSQL real). |
| **Evidência dos casos exigidos** | (1) O fallback usa exatamente a revisão e o modelo da política (`usedConnectionRevision`, `usedModel` e o modelo passado ao provedor). (2) Revisão mais nova reconhecida e não testada **não** substitui a fixada. (3) Revisão mais nova testada e ativada também não substitui. (4) Ligar sem teste, com teste reprovado ou com teste vencido é recusado (`AI_FALLBACK_TEST_REQUIRED` / `AI_FALLBACK_TEST_EXPIRED`). (5) Alternativa de outra revisão da mesma chave do primário é recusada ao configurar e ignorada em `fallbackForGateway()`; o executor também a recusa. (6) Revisão fixada inexistente, desabilitada, com modelo divergente ou digest alterado falha **antes do adapter** — o provedor alternativo não é chamado (`generate` chamado uma única vez). (7) Execução e streaming obedecem ao mesmo contrato, com o mesmo teste em ambos os modos. (8) A auditoria identifica chave, revisão, modelo, número da tentativa e origem do fallback nas duas linhas de `generation_executions`. (9) Contrato antigo com contrato novo falha explicitamente, nos dois sentidos. |

### P0.11 — Operações genéricas do Norman autorizadas ao token do Norman

| | |
| --- | --- |
| **Defeito** | O adapter do Norman troca a operação pela variante genérica quando não há cliente (`chat` → `chat_generic`, e o mesmo para as outras cinco). O consumidor `norman` do executor declarava **só** o lado vinculado. Uma conversa perfeitamente válida, antes da escolha do cliente, chegava como `chat_generic` e recebia **403** — com as duas suítes verdes, porque o adapter testava a troca de nome e o controller testava a autorização, cada um com a sua própria lista. |
| **Causa** | Duas listas escritas à mão para o mesmo par de operações, em repositórios diferentes. Acrescentar um par genérico no registro de operações não acrescentava a autorização, e nada falhava. |
| **Correção** | `src/auth/consumer-registry.ts` passou a **derivar** as operações do Norman de `GENERIC_COUNTERPART`, que é a mesma fonte que descreve os dois modos no registro do executor. A lista das vinculadas continua explícita e auditável; o par genérico de cada uma vem do registro. |
| **O que não mudou** | A separação entre os dois modos continua inteira: a genérica recusa `clientId` e a vinculada exige. `clientId` não voltou a ser opcional em operação nenhuma. Nenhuma regra permissiva foi criada — quem entra por `INTERNAL_CONSUMERS` continua declarando as próprias operações, uma a uma, e não herda nada do Norman. |
| **Arquivos** | LLM-backend: `src/auth/consumer-registry.ts`. |
| **Testes** | `src/auth/consumer-registry.test.ts` (+5: o par genérico de cada vinculada autorizado, toda operação autorizada existente no registro, a genérica continuando sem vínculo com cliente, e outra aplicação **não** herdando as genéricas); `contract/norman-gateway.contract.test.ts` (a verificação cruzada: toda operação que o mapa `GENERIC_FEATURE` do Norman produz precisa estar em `NORMAN_FEATURES`). |
| **Evidência dos casos exigidos** | (1) Com `INTERNAL_API_TOKEN` válido, a conversa genérica atravessa `InternalAuthGuard`, `ValidationPipe` e controller por HTTP real e é registrada como `chat_generic` em `generation_executions`. (2) O consumidor sem a operação continua recebendo `403`, tanto na genérica quanto no escopo de cliente. (3) `chat` com cliente continua exigindo o escopo `client`. (4) `chat_generic` com `clientId` continua recusado com `400` pela validação da operação. (5) O adapter sem cliente produz `chat_generic`; com cliente, `chat` — e é o adapter real que produz os dois no teste de contrato. (6) A verificação cruzada existe e falha: revertendo a derivação, **8 dos 15** casos da suíte de contrato caem, inclusive a conversa genérica. |

### P0.12 — Trava operacional resolvendo ativação real, efetiva e determinística

| | |
| --- | --- |
| **Defeito** | Com `NORMAN_AI_FORCE_CONNECTION` preenchida, `activeSnapshot()` escolhia a conexão com `Array.find()` sobre a lista de conexões — que pode conter várias revisões da mesma chave, sem ordenação — e fabricava a identidade `forced:<chave>`. Como o executor passou a validar toda geração contra `connection_activations`, essa identidade não existe lá: com `AI_GENERATION_PATH=gateway`, a trava produzia um pedido recusado antes do provedor. E, mesmo que fosse aceita, a revisão escolhida seria a que a ordem do array entregasse — podendo ser uma sincronizada para teste, nunca ativada. |
| **Correção** | A trava passou a resolver uma ativação **real**. `latestConfirmedActivationForKey()` (novo, em `ai-provider-control.repository.ts`) junta ativações, conexões e tentativas por chave lógica, aceita ativações antigas sem tentativa — as que a migration `0024` copiou — e tentativas no estado `active`, exige revisão habilitada, ordena pelo histórico de ativação e devolve a tupla exata. O serviço usa `activationId`, `connectionId`, revisão e modelo dessa ativação. |
| **Falha fechada** | Chave sem nenhuma ativação confirmada, ou cuja conexão foi desabilitada depois, para com `503 AI_PROVIDER_FORCED_WITHOUT_ACTIVATION` **antes** de o cliente do gateway ser chamado. |
| **O que não mudou** | Nenhuma exceção foi criada no executor para aceitar `forced:*`. A validação de ativação não foi enfraquecida em ponto nenhum. A ativação em duas fases e o fallback fixado por revisão ficaram intactos. A regra que impede trocar provedor e modelo pela tela com a trava ligada continua valendo. |
| **Visão administrativa** | `overview()` continua declarando `forcedConnectionKey` e passou a declarar `forcedActivation`: a ativação, a revisão e o modelo que a trava resolve, ou `resolved: false` com o motivo. A tela mostra esse motivo — sem ele, uma trava que não resolve nada só apareceria na primeira conversa, como indisponibilidade sem explicação. |
| **Arquivos** | Norman: `ai-provider-control/{ai-provider-control.types.ts,ai-provider-control.repository.ts,ai-provider-control.service.ts}`, `client/src/features/ai-knowledge/{ai-provider.api.ts,ai-knowledge-screen.tsx}`. |
| **Testes** | `ai-provider-control.service.test.ts` (+11 no bloco "trava operacional"); `activation-protocol.integration.test.ts` (+11 num bloco novo, PostgreSQL embarcado); `ai-knowledge-screen.test.tsx` (+2); `contract/norman-gateway.contract.test.ts` (a trava gerando ponta a ponta e a identidade fabricada sendo recusada). |
| **Evidência dos casos exigidos** | (1) A trava manda ao gateway o `activationId` real, a revisão real e o modelo real — provado por HTTP, com o executor validando contra o registro de ativações dele. (2) O executor aceita esse pedido. (3) `forced:<chave>` não existe mais em código de produção, e o executor recusa quem a mandar (`400`). (4) Duas revisões ativadas da mesma chave: escolhe a ativação confirmada mais recente pelo histórico — provado em PostgreSQL, ativando a revisão 2 **antes** da 1 e conferindo que a escolhida é a 1. (5) Revisão mais nova apenas reconhecida, nunca ativada, não é escolhida. (6) `pending`, `failed` e `cancelled` nunca são escolhidas. (7) Conexão desabilitada não é escolhida, mesmo tendo sido ativada. (8) Chave sem ativação confirmada falha antes do cliente do gateway, e o provedor não é chamado. (9) Ativação legada migrada — sem tentativa nenhuma — continua utilizável. (10) Sem a variável, o caminho normal não consulta a ativação por chave e responde a mesma ativação vigente de antes. (11) A busca alcança uma ativação muito além das últimas 20 linhas da tela. |

### Correção documental

O comentário de `server/modules/ai/gateway-ai.adapter.ts` que afirmava *"O
streaming ainda não existe no gateway. Enquanto não existir, as entradas em
streaming pedem a resposta inteira e a entregam de uma vez"* estava defasado: o
adapter usa `client.stream` desde a rodada anterior, com deltas reais,
cancelamento propagado e evento terminal separado do texto. A documentação foi
corrigida para descrever o que o código faz. Nenhum comportamento mudou.

### Invariantes da rodada de consistência, um por um

Os doze invariantes exigidos em 08/09, com onde cada um é provado. Nenhum deles
depende de bloqueio externo para ser verificado localmente.

| # | Invariante | Onde é provado |
| --- | --- | --- |
| 1 | O Norman nunca anuncia ativação como vigente antes de o executor reconhecer a mesma identidade, conexão e revisão | `activation-contract.integration.test.ts` ("a ativação só fica vigente depois de o executor confirmá-la"); a ordem `confirm → markConfirmed → commit` é asserida em `ai-provider-control.service.test.ts` |
| 2 | Falha ou timeout entre os serviços não troca a IA em silêncio | `activation-contract.integration.test.ts` (recusa 400, resposta perdida e 500) e `ai-provider-control.service.test.ts` (recusa e incerteza) |
| 3 | Resposta de erro da rota não deixa ativação nova efetiva | os mesmos testes: `latestActivation()` e `activeSnapshot()` continuam na anterior, e `commitActivation` não é chamado |
| 4 | Repetir com a mesma identidade é idempotente | `confirmActivation` idempotente pela tupla (`connection-revisions.service.test.ts`, PostgreSQL real); `commitActivation` e `markActivationConfirmed` idempotentes (`activation-protocol.integration.test.ts`); repetição ponta a ponta em `activation-contract.integration.test.ts` |
| 5 | Duas ativações concorrentes não terminam as duas vencedoras | `activation-protocol.integration.test.ts` (os dois índices únicos parciais, inclusive por `INSERT` fora do lock), `activation-contract.integration.test.ts` e `ai-provider-control.service.test.ts` |
| 6 | O executor não perde ativação válida porque uma tentativa posterior gravou outra identidade | `connection-revisions.service.test.ts` ("confirmar uma tentativa nova não apaga o vínculo válido anterior") e `activation-contract.integration.test.ts` |
| 7 | O fallback aponta para revisão exata, testada e ainda válida | `generation.service.test.ts` (bloco do fallback fixado), `fallback-policy.test.ts`, `ai-provider-control.service.test.ts` (bloco "revisão fixada") |
| 8 | Criar ou sincronizar revisão nova não altera fallback já aprovado | `generation.service.test.ts` (revisão nova reconhecida, e também testada e ativada) e `ai-provider-control.service.test.ts` ("uma revisão posterior da alternativa não muda a política existente") |
| 9 | O fallback não usa a mesma conexão lógica do primário só porque os ids diferem | `ai-provider-control.service.test.ts` (`AI_FALLBACK_SAME_CONNECTION_KEY` ao configurar e recusa em `fallbackForGateway()`), `generation.service.test.ts` (recusa no executor) |
| 10 | Falta de confirmação, revisão divergente, teste vencido ou configuração alterada falha fechado, antes do provedor externo | `generation.service.test.ts` (nove formas de recusa antes do adapter, com `generate` chamado uma vez), `connection-revisions.service.test.ts`, `ai-provider-control.service.test.ts` |
| 11 | URL, chave e segredo de provedor continuam só no LLM-backend | `ai-provider-control.service.test.ts` (bloco "fronteira de segredo", ambiente vazio), `connection-revisions.service.test.ts` ("nada do segredo nem da URL sai no registro"), `internal-generation.controller.test.ts` |
| 12 | Caminho legado e fallback seguem desligados/inalterados por padrão | `FALLBACK_DISABLED` e o padrão `is_enabled = false` da tabela; `fallback-policy.test.ts` ("desligado por padrão"), `generation.dto.test.ts` (desligado não exige revisão), `generation-path.test.ts` e `text-provider.test.ts` intactos |

### Correções anteriores mantidas

Os itens da rodada anterior que **não** foram contraditados continuam válidos e
com os testes originais: revogação fail-closed com lápide durável, tokens
estruturados de marca com precedência declarada, paridade dos prompts de
produção (incluindo a regressão Selenita), streaming realmente incremental,
citações e evidências chegando à tela e à auditoria, saúde por camadas e
retenção idempotente, e o registro do provedor e do modelo realmente usados.

---

## 2. Commits locais, por repositório

Depois do squash exigido, cada repositório tem **exatamente um commit** após o
commit-base.

### LLM-backend-Norman (branch `feature/formatos-legados-doc-xls-pptx`)

- Commit-base preservado: `aded5b9` — *docs: relatório da implementação da camada de conhecimento e do gateway*
- **Hash anterior ao squash de 08/09:** `0e064fc13d97a0d1ce6d75e0c5c0160975a4daa6` (`0e064fc`), que era a ponta de 10 commits
- **Hash do squash de 08/09:** `f6404b38c7ace1ecb5d182d3919c9e0e3b8ad98c` (`f6404b3`) — *feat: conclui ajustes de RAG e gateway multiprovedor*
- Depois da rodada de 09/09: **1 commit** — `feat: conclui gateway multiprovedor e camada de conhecimento`, que reúne todo o trabalho anterior da branch **e** as correções de consistência. `git rev-list --count aded5b9..HEAD` → `1`.

### Norman (branch `feature/finalizacao-camada-conhecimento`)

- Commit-base preservado: `2af225a` — *fix(ia): a tela deixa de prometer troca de provedor imediata*
- **Hash anterior ao squash de 08/09:** `ba333e6f7f5a0872757b084080b82e09b939f1c1` (`ba333e6`), que era a ponta de 13 commits
- **Hash do squash de 08/09:** `fc32b99954c822ccc32fc3516fd18d458d25e1da` (`fc32b99`) — *feat: conclui conhecimento de IA e integração multiprovedor*
- **Hash final, depois da rodada de 09/09:** `6caba183cf8ae859e4fb2bda825047dd4706f92d` (`6caba18`) — `feat: conclui controle de provedores e conhecimento de clientes`. `git rev-list --count 2af225a..HEAD` → `1`.

**Contagem total:** 23 commits locais antes do primeiro squash (10 no
LLM-backend, 13 no Norman) viraram **2 commits**, um por repositório, e a rodada
de 09/09 foi incorporada a esses mesmos dois por `git commit --amend` — não
houve commit novo. A versão anterior deste relatório dizia "22 commits" e "9
commits" no LLM-backend; o número certo antes do squash era 10 e 13.

O hash final do LLM-backend **não** está registrado acima porque este relatório
é parte do conteúdo daquele commit, e um commit não pode conter o próprio hash.
Ele é obtido com `git rev-parse HEAD` na branch
`feature/formatos-legados-doc-xls-pptx`, e é o único commit entre `aded5b9` e
`HEAD`.

Autoria e committer em ambos: `admin@ptwag.com` — `Diego Alípio Abenicio` no
LLM-backend e `Diego Abenicio` no Norman, as identidades já configuradas em cada
repositório. Nenhum rodapé adicional de autoria foi incluído.

Antes do squash de 08/09 foram criadas tags locais de segurança apontando para a
ponta anterior (`pre-squash-2026-09-08` nos dois repositórios). **Nenhuma tag foi
publicada.**

---

## 3. Comandos executados e resultados

### LLM-backend-Norman

| Comando | Resultado (09/09/2026, rodada de bordas) |
| --- | --- |
| `npm run typecheck` | passou, sem saída |
| `npm run build` | passou (`nest build`) |
| `npm test` | **45 arquivos passaram, 2 ignorados; 692 testes passaram, 16 ignorados** |
| `npm run test:contract` | **1 arquivo, 15 testes passaram** (suíte nova, §3.1) |
| `git diff --check` | limpo |

Linha de base da rodada anterior: 45 arquivos e **688 testes** passando, 16
ignorados. Ficaram **692 passando** (+4, todos em `consumer-registry.test.ts`),
com os mesmos 16 ignorados — nenhum teste foi transformado em `skip`. A suíte de
contrato roda por um comando próprio, pelos motivos de §3.1, e os 15 testes dela
não entram nessa contagem.

### Norman

| Comando | Resultado (09/09/2026, rodada de bordas) |
| --- | --- |
| `npm run check` | passou |
| `npm run check:server` | passou |
| `npm run build` | passou (`dist/index.cjs`, 2.5 MB) |
| `npm test` | **451 arquivos passaram, 1 ignorado; 11.155 testes passaram, 4 ignorados** |
| `npm run test:coverage` | **passou o gate**: statements 99,07% · branches 93,63% · functions 98,65% · lines 99,62% |
| `git diff --check` | limpo |

**Correção de contagem.** A versão anterior deste relatório registrava *"450
arquivos passaram"* na rodada de consistência. A contagem correta era **451**, e
é a que a auditoria observou. O número está corrigido aqui.

Linha de base da rodada anterior: 451 arquivos e **11.130 testes** passando, 4
ignorados. Ficaram **11.155 passando** (+25), com os mesmos 4 ignorados — nenhum
teste foi transformado em `skip` e nenhum arquivo de teste novo foi criado do
lado do Norman (os 25 entraram em arquivos que já existiam).

Os limiares de cobertura são 99,0% / 93,6% / 98,5% / 99,6%. Na primeira medição
desta rodada o gate passou, mas **abaixo** dos números da rodada anterior:
statements 99,06% (contra 99,07%) e branches 93,60% (contra 93,62%) — quatro
ramos novos sem exercício, entre eles a chave lógica vazia na consulta da trava e
o caminho de erro inesperado ao descrever a trava na tela. Cobri-los devolveu os
números a 99,07% e 93,63%, ou seja, **sem regressão** em nenhuma das quatro
métricas. O número está registrado aqui como ele saiu, não como se tivesse
passado de primeira.

### 3.1 A suíte de contrato entre os dois serviços

Esta rodada criou o que faltava e que teria evitado os dois defeitos: uma suíte
que sobe **os dois lados de verdade** e exercita a fronteira. Ela vive em
`contract/` na raiz do LLM-backend, roda por `npm run test:contract` (ou
`contract/run.sh`) e está documentada em `contract/README.md`.

O que é real nela:

| Lado | O que roda de verdade |
| --- | --- |
| LLM-backend | servidor HTTP do Nest, `InternalAuthGuard`, `ValidationPipe` com os DTOs, `InternalGenerationController`, `GenerationService`, `ConnectionRevisionsService`, PostgreSQL embarcado com as migrations de revisões e ativações |
| Norman | `createLlmGatewayClient`, `createGatewayAiAdapter`, `createAiProviderControlService`, o repository drizzle do plano de controle, PostgreSQL embarcado com `AI_CONTROL_MIGRATIONS` |

Stubado: **somente os dois modelos externos** — a geração de texto e o cálculo de
embedding —, e sempre depois de toda a autenticação, validação e autorização.
Nenhuma regra de autorização foi reimplementada num servidor falso, porque foi
exatamente essa duplicação que deixou os dois defeitos passarem. Nada de Grok,
OpenAI, Ollama, Redis ou infraestrutura remota; o token interno é de teste.

Os 15 casos provam: conversa genérica autorizada ponta a ponta; conversa por
cliente autorizada e isolada do acervo de outro cliente; consumidor restrito
recebendo `403` na operação genérica e no escopo de cliente; genérica com cliente
e vinculada sem cliente recusadas pela validação; trava operacional gerando com
ativação confirmada real; trava sem ativação confirmada falhando antes do
gateway; `forced:<chave>` recusada pelo executor; contrato v1 contra executor v2
falhando explicitamente; token inválido barrado no guard; nenhuma URL nem
credencial de provedor atravessando o contrato; e a verificação cruzada de que
toda operação do mapa `GENERIC_FEATURE` do Norman está autorizada ao consumidor
`norman`.

**A suíte foi verificada contra os próprios defeitos.** Revertendo a derivação
das operações genéricas, 8 dos 15 casos falham. Revertendo a resolução da trava
para `Array.find()` + `forced:<chave>`, 2 falham — inclusive a geração forçada
ponta a ponta. Ela não é decorativa.

Ela fica **fora** do `npm test` de propósito: o LLM-backend precisa continuar
testável sozinho, sem o Norman presente, e o mesmo vale para o `tsc --noEmit` do
CI (o diretório `contract/` está excluído do `tsconfig.json`). Quando o Norman
não está em `../Norman` nem em `NORMAN_REPO_PATH`, a suíte **falha** dizendo
isso — ela não se ignora em silêncio.

### Verificações adicionais pedidas

| Verificação | Como foi feita | Resultado |
| --- | --- | --- |
| Contrato das duas pontas com revisão inválida | `server/modules/ai/revision-contract.integration.test.ts`: executor HTTP real que resolve `connectionKey + connectionRevision` como o real, com cinco formas de revisão inválida | passou — todas recusadas, provedor nunca chamado, e a recusa não cai para o legado |
| Ativação sem chave de Grok/OpenAI no Norman | `ai-provider-control.service.test.ts`, bloco "fronteira de segredo", com ambiente vazio | passou |
| Cancelamento por HTTP real | `src/gateway/stream-cancellation.integration.test.ts` e `server/modules/ai/ai.stream-cancellation.integration.test.ts`, com `createServer` e `fetch` reais | passou |
| Concorrência real do claim de áudio | duas instâncias do serviço, com `workerId` distinto, sobre as mesmas linhas e o mesmo armazenamento, disputando a mesma fonte | passou — uma única chamada de transcrição |
| Falha do storage antes do `202` | `ai-knowledge.service.test.ts`, bloco "persistência antes do aceite" | passou |
| Upload real das extensões legadas pela rota do Norman | `legacy-formats-upload.integration.test.ts`: multipart e HTTP reais, com containers OLE e ZIP legítimos, e comparação byte a byte do que foi gravado | passou |
| Raiz crua e raiz sanitizada para o mesmo cliente | `client-scope-search.integration.test.ts` contra Postgres real | passou |
| Prontidão de documento fora da pasta nova | `ai-knowledge.service.test.ts` (`01_Brand_Guide_Institucional` → `ready`) | passou |
| Busca por segredos reais | varredura de todos os arquivos rastreados e não ignorados dos dois repositórios com padrões de chave (`xai-`, `sk-`, `gsk_`, `AIza`, `BEGIN PRIVATE KEY`) | nenhuma ocorrência nova; as únicas correspondências são chaves de teste falsas, pré-existentes, em `server/google-drive*.test.ts` |
| Nenhum teste convertido em `skip` | comparação dos `skip` do working tree com os de `HEAD` nos dois repositórios | os 3 `describe.skip` existentes são pré-existentes e continuam condicionados a variável de ambiente; nenhum novo |
| Menções a assistentes | varredura em código, documentação e mensagens de commit | nenhuma ocorrência |
| Testes de contrato com os dois processos reais no mesmo processo | `contract/norman-gateway.contract.test.ts`: servidor HTTP, guard, DTOs e controller reais do LLM-backend; cliente, adapter e plano de controle reais do Norman; um PostgreSQL embarcado de cada lado; só os modelos externos stubados | passou — 15 casos. **Não** substitui os dois serviços publicados e conversando pela rede em dev (§7) |
| A suíte de contrato falha quando os defeitos voltam | reversão temporária de cada correção, com a suíte rodando em seguida | 8 de 15 casos caem sem a derivação das operações genéricas; 2 caem sem a resolução real da trava |
| Autorização por consumidor, por HTTP real | mesma suíte: token do Norman e token de um consumidor restrito declarado em `INTERNAL_CONSUMERS` | passou — o Norman gera nas genéricas; o restrito recebe `403` na operação genérica e `403` ao tentar escopo de cliente |
| Trava operacional com ativação confirmada real | mesma suíte, com a ativação semeada pela migration do Norman confirmada no executor pelas rotas reais | passou — o `activationId` que atravessa é o do histórico do Norman, o executor o reconhece, e ele não casa com `forced:` |
| Consulta da trava em PostgreSQL | `activation-protocol.integration.test.ts`, bloco "a ativação confirmada de uma chave lógica", embarcado pelo protocolo de fio | passou — 11 casos: ordenação por histórico, legada migrada, `pending`/`failed`/`cancelled`, revisão desabilitada, revisão nunca ativada, chave vazia e alcance além das 20 linhas da tela |
| `forced:<chave>` fora do código de produção | `grep -rn "forced:"` nos dois repositórios, ignorando `node_modules` e `dist` | nenhuma ocorrência em código de produção; as únicas são a asserção de teste que garante que ela não volte e as menções em documentação |
| Testes contra PostgreSQL + pgvector externo | **não executado** contra instância externa; a suíte usa Postgres embarcado com pgvector | ver §7 |
| Ativação: falha de confirmação remota mantém a anterior funcionando | `activation-contract.integration.test.ts`, com executor HTTP real que responde 400 | passou — `latestActivation()` e `activeSnapshot()` continuam em `act-inicial`, nenhuma tentativa fica pendente, e o cache não é invalidado |
| Ativação: resposta perdida **depois** da confirmação | mesmo teste, com o executor gravando a confirmação e derrubando o socket (`socket.destroy()`) antes de responder | passou — resposta `503 AI_PROVIDER_ACTIVATION_UNCONFIRMED`, tentativa fica `pending`, a divergência é observável nos dois lados, e `reconcileActivations()` a conclui com a mesma identidade |
| Ativação: retry com a mesma identidade depois de timeout | mesmo teste, repetindo a ativação depois da resposta perdida | passou — a tentativa anterior é concluída, o executor continua com **uma** confirmação, e a repetição responde 409 porque a vigente mudou |
| Ativação: duas administrativas concorrentes | `activation-protocol.integration.test.ts` (PostgreSQL real, `Promise.allSettled`), `activation-contract.integration.test.ts` (HTTP real) e `ai-provider-control.service.test.ts` | passou — uma só prepara, uma só confirma, e o índice único parcial recusa a segunda pendente mesmo por `INSERT` direto, fora do lock |
| Ativação: CAS durável | `activation-protocol.integration.test.ts` | passou — `INSERT` direto de uma segunda vencedora sobre a mesma ativação observada é recusado por `ai_provider_activation_intents_expected_idx` |
| Ativação: tentativa pendente não é lida como vigente | `activation-protocol.integration.test.ts`, com uma linha de ativação órfã inserida à mão | passou — `latestActivation()` e `listActivations()` a ignoram |
| Ativação: histórico continua imutável | `activation-protocol.integration.test.ts`, `UPDATE` direto em `ai_provider_activations` e em `ai_fallback_policies` | passou — os dois gatilhos de histórico imutável continuam recusando |
| Fallback: nunca escolhe revisão por ser "a mais nova" | `generation.service.test.ts`, bloco "fallback fixado na revisão aprovada" | passou — `latestEnabled()` deixou de existir; com revisão 2 reconhecida (e também testada e ativada), o fallback continua na revisão 1 fixada na política |
| Fallback: contrato antigo com contrato novo | `revision-contract.integration.test.ts`, executor HTTP real que valida `contractVersion` | passou — recusa explícita nos dois sentidos, e política ligada sem `connectionRevision`/`model` é recusada na validação |
| Migrations exercidas em PostgreSQL | `connection-activations.migration.integration.test.ts` e `activation-protocol.migration.test.ts`, embarcado pelo protocolo de fio | passou — banco vazio e estado das migrations atuais, com idempotência e preservação do que já existia |

---

## 4. Testes ignorados

### LLM-backend (16, todos pré-existentes)

| Arquivo | Testes | Motivo |
| --- | --- | --- |
| `src/knowledge/knowledge.processor.integration.test.ts` | 9 | `describe.skip` quando `INGESTION_IT_DATABASE` não está definido. Exige Postgres externo com o modelo de embeddings disponível. |
| `src/ingestion/ingestion.processor.integration.test.ts` | 7 | mesma condição. |

### Norman (4, pré-existentes)

`server/modules/knowledge/knowledge-backfill.integration.test.ts`, condicionado a
variável de ambiente.

**Nenhum teste foi transformado em `skip` nesta tarefa, e nenhum `skip` novo foi
criado.**

---

## 5. Migrations criadas (nenhuma executada remotamente)

| Repositório | Arquivo | O que faz |
| --- | --- | --- |
| LLM-backend | `1757500000000-KnowledgeRevocations.ts` | rodada anterior: `knowledge_revocations` |
| LLM-backend | `1757600000000-ConnectionRevisions.ts` | rodada anterior: `connection_revisions`, com única por (conexão, revisão) e índice por conexão habilitada |
| LLM-backend | `1757700000000-ConnectionActivations.ts` | **novo (09/09)**: `connection_activations` — uma linha por identidade confirmada, com `activation_id` único e a tupla `(activation_id, connection_key, revision)` única. Aditiva: `connection_revisions.activation_id` não é reescrita, e as ativações que já estavam gravadas nela são copiadas para a tabela nova. |
| Norman | `0020_knowledge_revocation_outbox.sql` | rodada anterior |
| Norman | `0021_ai_provider_openai_connection.sql` | rodada anterior |
| Norman | `0022_knowledge_audio_durable_queue.sql` | rodada anterior |
| Norman | `0023_knowledge_audio_lease.sql` | rodada anterior: `claimed_by`, `claimed_at`, `lease_until` e `next_attempt_at` em `knowledge_sources`, com o índice de retomáveis refeito |
| Norman | `0024_ai_activation_protocol.sql` | **novo (09/09)**: `ai_provider_activation_intents` com `CHECK` de estado e os dois índices únicos parciais (uma pendente por instalação; uma vencedora por ativação observada); `connection_revision` e `model` em `ai_fallback_policies`; e o registro das ativações já existentes como `active`, para a leitura da vigente responder o mesmo depois do deploy |

Todas foram exercidas contra PostgreSQL de verdade — embarcado, servido pelo
protocolo de fio, com o `pg` e o `drizzle`/`typeorm` falando com ele como falam
com o banco real. As duas novas têm suíte dedicada, que sobe **sobre banco vazio
e sobre o estado produzido pelas migrations anteriores**, confere colunas,
índices e restrições, prova a idempotência de subir duas vezes e prova que as
ativações e as políticas que já existiam continuam válidas:
`src/database/connection-activations.migration.integration.test.ts` e
`server/modules/ai-provider-control/activation-protocol.migration.test.ts`.

O Norman passou a ter esse harness — `server/test/embedded-postgres.ts`, com
`@electric-sql/pglite` e `@electric-sql/pglite-socket` como dependências **de
desenvolvimento** — porque o `db` falso mostra que o repository montou a consulta
pretendida, e não que o índice recusa a segunda linha. `NORMAN_IT_DATABASE_URL`
sobrepõe com um PostgreSQL externo quando houver um.

Nenhuma migration foi aplicada em banco remoto, e nenhum backfill foi executado.

---

## 6. Diferenças deliberadas em relação ao legado

1. **Framework de briefing vazio é erro no gateway.** O legado devolve os seis campos em branco e segue; o gateway recusa. Campo em branco na tela sem ninguém saber que a geração falhou é pior do que a falha visível.
2. **O modo genérico virou operação própria.** A conversa antes da escolha do cliente continua possível, mas por uma operação declarada, com prompt que diz que não há acervo. A operação vinculada passou a exigir cliente. A versão anterior deixava as duas como a mesma operação com cliente opcional — e era isso que fazia a tela por cliente degradar em silêncio.
3. **Temperatura e teto de saída são padrão declarado por operação**, com o pedido ainda podendo sobrepor.
4. **`generateInsights` não cai no legado** quando o gateway está ativo.
5. **O parcial do briefing de entregável em streaming** é o campo `reply` extraído do JSON incompleto, como no legado.
6. **O envio de áudio deixou de ser aceito sem armazenamento durável.** Antes, sem storage configurado, a transcrição rodava em memória e o envio era aceito. Aceitar sem durabilidade é a origem do defeito P0.3.
7. **O caminho legado deixou de aceitar provedor externo.** Ele aponta para o Ollama local, com variáveis próprias. Trocar de provedor externo é decisão do plano de controle, e ela se aplica ao gateway — não a um segundo cadastro paralelo.

---

## 7. Bloqueios externos reais (nenhum destes foi validado)

Esta máquina não tem PostgreSQL, Redis nem Ollama instalados ou em escuta
(`psql`, `redis-cli`, `ollama` ausentes; portas 5432, 6379 e 11434 fechadas). As
consequências:

1. **Teste de contrato entre os dois serviços: executado no mesmo processo; entre dois processos publicados, não.** Esta rodada criou `contract/norman-gateway.contract.test.ts` (§3.1), que sobe o servidor HTTP, o guard, os DTOs e o controller reais do LLM-backend e usa o cliente, o adapter e o plano de controle reais do Norman, com um PostgreSQL embarcado de cada lado e só os modelos externos stubados. Foi ele que expôs os dois defeitos desta rodada. O que ele **não** é: dois serviços publicados, cada um no seu processo e no seu banco de dev, conversando pela rede. Isso continua **por validar em dev**.
2. **Grok não foi testado com chave real.** A chave compartilhada anteriormente está exposta e **não foi usada**; nenhuma chave substituta foi provisionada. Ollama não está no ar. O `ConnectionTestService` foi exercido apenas contra provedor de teste. **O aceite do multiprovedor depende disso.**
3. **Fila BullMQ real: não exercitada.** O arrendamento, o backoff e a recuperação foram testados por unidade e por simulação de queda; nenhum job passou por um Redis de verdade.
4. **Streaming contra provedor real: não exercitado.** O parser de SSE e o cancelamento foram testados com servidor HTTP real, mas o outro lado era um corpo controlado, não um provedor.
5. **Retenção: nenhum prazo foi decidido.** As quatro variáveis continuam vazias, a limpeza desligada e a pendência visível em `/health`.
6. **O armazenamento durável de áudio não foi exercido contra o Supabase real.** A cópia durável foi testada contra armazenamento em memória com o mesmo contrato.
7. **O protocolo de ativação não foi exercido entre dois processos de verdade.** Ele foi exercido por HTTP real contra um executor que responde exatamente como o real (inclusive derrubando o socket depois de gravar a confirmação) e contra PostgreSQL embarcado com as migrations reais. O que falta é a mesma sequência com o Norman e o LLM-backend de pé, cada um com o seu banco. Continua **por validar em dev**.
8. **A concorrência de ativação não foi exercida entre réplicas separadas.** As duas ativações concorrentes foram provadas na mesma transação de PostgreSQL, com os índices únicos parciais recusando a segunda — inclusive por `INSERT` direto, fora do advisory lock. Duas réplicas do Norman apontando para o mesmo banco continuam **por validar em dev**.
9. **O PostgreSQL embarcado não é o PostgreSQL de produção.** Ele é servido pelo protocolo de fio, e o `pg`, o `drizzle` e o `typeorm` falam com ele normalmente, então transação, advisory lock, índice único parcial, `CHECK` e gatilho foram exercidos de verdade. Ainda assim é outra distribuição: rodar as duas migrations novas contra a instância de dev (`NORMAN_IT_DATABASE_URL` e `INGESTION_IT_DATABASE`) continua pendente.

---

## 8. Roteiro posterior de publicação e aceite em dev

Nada abaixo foi executado.

**Antes de publicar**

1. Provisionar no ambiente seguro do LLM-backend a chave substituta do Grok e, se for o caso, a da OpenAI, com `*_MODEL` e `*_ALLOWED_MODELS` preenchidos. A chave antiga do Grok está exposta e não pode voltar. **Não** replicar nada disso no Norman.
2. Decidir os quatro prazos de retenção e preenchê-los.
3. Definir `REDIS_PASSWORD` e um `REDIS_DB` por ambiente.
4. Se o rollback pelo legado for apontar para outro Ollama, definir `LEGACY_AI_BASE_URL` e `LEGACY_AI_MODEL`. Sem elas, ele usa o Ollama local.

**Aplicar as migrations, na ordem**

5. LLM-backend: `npm run migration:run` (aplica `KnowledgeRevocations`, `ConnectionRevisions` e `ConnectionActivations`).
6. Norman: `npm run db:migrate` (aplica `0020` a `0024`).
6a. Conferir, depois da `0024`, que cada ativação que já existia ganhou uma tentativa `active` e que `latestActivation()` responde a mesma de antes. A migration faz isso, e há teste; a conferência em dev é o que prova no dado real.

**Aceite em dev, com o legado ainda como padrão**

7. Subir os dois serviços com `AI_GENERATION_PATH=legacy`. Confirmar que a conversa continua idêntica.
8. Na administração, testar a conexão `ollama`. O teste tem de sair do LLM-backend, e o log de lá tem de mostrar a revisão reconhecida antes do teste.
9. Testar `openai` e `grok`: sem provisionamento **no LLM-backend** devem aparecer como provisionamento pendente, com o motivo vindo de lá.
10. Confirmar o aceite de P0.1: remover `GROK_API_KEY` e `OPENAI_API_KEY` do ambiente do Norman e repetir os passos 8 e 9. Nada pode mudar.
11. Ativar uma conexão e conferir, no LLM-backend, que a **identidade exata** ficou confirmada: `GET /internal/generation/connections/activations/{activationId}` responde 200 com a mesma chave e a mesma revisão, e as capacidades trazem aquele `activationId` em `recognizedRevisions[].activationIds`.
12. Rodar `npm run ai:check` no Norman: ele agora cobra revisão reconhecida, a identidade vigente confirmada do outro lado e a ausência de tentativa pendente.
12a. Derrubar o LLM-backend e tentar ativar: a rota tem de responder `503 AI_PROVIDER_ACTIVATION_UNCONFIRMED`, a IA anterior tem de continuar atendendo, e a tela tem de mostrar a tentativa em andamento. Subir o backend e chamar `POST /api/admin/ai/providers/activations/reconcile`: a tentativa tem de ser encerrada (o executor não confirmou nada) e a ativação anterior tem de permanecer.
12b. Repetir o passo anterior interrompendo a resposta **depois** de o executor confirmar (por exemplo, matando o proxy). A reconciliação tem de **concluir** a ativação, com a mesma identidade que o executor já tinha registrado.
12c. Ligar o fallback e conferir na tela a revisão e o modelo fixados. Depois trocar o modelo da conexão alternativa, testar e ativar a revisão nova: a política tem de continuar apontando para a revisão anterior, e a geração com fallback tem de registrar essa revisão em `ai_request_snapshots.connection_revision`.

**Ordem segura da publicação do contrato v2**

O executor recusa a versão 1 e o Norman novo recusa um executor antigo. Essa
recusa recíproca é correta — ela é o que impede o fallback de ser resolvido por
aproximação — mas significa que **não existe publicação escalonada sem
indisponibilidade se o gateway já estiver ativo**. Esta atualização **não** é sem
interrupção, e o roteiro não a descreve como tal. O guia operacional
(`OPERACAO_GATEWAY_E_CONHECIMENTO.md`, §3.1) traz a mesma ordem:

12d. Manter `AI_GENERATION_PATH=legacy` nos dois serviços durante toda a
publicação. Em `legacy` a geração não passa pelo gateway, e a diferença de versão
não alcança nenhum usuário.
12e. Publicar e migrar o LLM-backend.
12f. Publicar e migrar o Norman.
12g. Validar antes de trocar a chave: `/health` com banco e fila em `ok`;
`GET /internal/generation/capabilities` respondendo `contractVersion: 2` e
declarando as operações genéricas; a revisão ativa aparecendo em
`recognizedRevisions`; e a ativação vigente do Norman confirmada no executor
(`GET /internal/generation/connections/activations/{activationId}` respondendo
200, não 404).
12h. Só então `AI_GENERATION_PATH=gateway` e reiniciar o Norman.
12i. Rollback: voltar a `legacy` e reiniciar o Norman — **sem** reverter
migrations. Elas são compatíveis com o caminho legado, e revertê-las perderia o
histórico de ativação de que o protocolo de duas fases depende.
12j. Se o gateway **já estiver ativo** num ambiente, a atualização exige janela
coordenada ou uma compatibilidade temporária que preserve todos os invariantes de
revisão. Aceitar de novo um fallback v1 sem revisão fixada **não** é opção: seria
reabrir o defeito que a versão 2 fechou.
12k. Se `NORMAN_AI_FORCE_CONNECTION` estiver em uso na janela, conferir na tela
administrativa que a trava aparece **resolvida**: chave sem ativação confirmada
faz a geração falhar fechada, com erro explícito, antes de chamar o gateway.

**Virada para o gateway, em dev**

13. `AI_GENERATION_PATH=gateway` só em dev. Rollback = voltar a variável.
14. Com um cliente cujo nome tenha espaço ou `&`: a conversa sem pasta tem de recuperar trecho do acervo, e a resposta tem de trazer `citations`. É o aceite de P1.2 em dado real.
15. Verificar o A/B de isolamento com dois clientes reais.
16. Enviar um documento pela aba de Conhecimento de IA — um `.xlsx` e um `.doc` — e conferir que aparecem na lista e chegam a `ready`.
17. Enviar o mesmo caminho com conteúdo novo: a versão anterior tem de sair de vigência sem ser apagada.
18. Enviar um áudio com o storage indisponível: o envio tem de **falhar**, e não responder aceite.
19. Enviar um áudio e reiniciar o Norman no meio: a transcrição tem de retomar sozinha, sem reenvio, e sem transcrever duas vezes com duas réplicas de pé.
20. Abrir uma conversa em streaming e fechar a aba: confirmar no log do provedor que a chamada foi encerrada.
21. Tirar o `clientId` de uma chamada por cliente: ela tem de falhar visivelmente, e o provedor não pode ser chamado.
22. Comparar, com as mesmas entradas, uma conversa pelo legado e uma pelo gateway.

---

## 9. Confirmação

- **Nenhum `git push` foi executado.** Cada repositório tem um commit local após o commit-base.
- **Nenhum `git push --force`, rebase remoto ou comando de publicação foi executado.**
- **Nenhum deploy foi executado.**
- **Nenhuma migration foi executada em banco remoto.** As novas rodaram apenas contra PostgreSQL embarcado de teste, servido pelo protocolo de fio.
- **Nenhum backfill foi executado.**
- **Nenhum dado ou serviço remoto foi alterado.**
- **Nenhuma branch nova foi criada.** O trabalho ficou em `feature/formatos-legados-doc-xls-pptx` e `feature/finalizacao-camada-conhecimento`.
- **Os commits-base foram preservados:** `aded5b9` e `2af225a`, com todo o histórico anterior intacto. `git rev-list --count aded5b9..HEAD` e `git rev-list --count 2af225a..HEAD` devolvem `1` em cada repositório.
- **As tags locais de segurança não foram publicadas.**
- **Os arquivos não rastreados que já existiam continuam não rastreados e intactos, e nenhum deles entrou no squash:** `AJUSTES_POS_AUDITORIA_RAG_MULTIPROVIDER_2026-09-08.md`, `CORRECOES_FINAIS_E_SQUASH_RAG_MULTIPROVIDER_2026-09-08.md`, `CORRECAO_FINAL_CONSISTENCIA_PROVEDORES_2026-09-08.md` e `PLANO_IMPLEMENTACAO_RAG_MULTIPROVIDER_2026-09-08.md` no LLM-backend; os handoffs e planos locais não rastreados no Norman.
- **Grok não foi testado com chave real.** A chave compartilhada anteriormente está exposta, não foi usada e não aparece em nenhum arquivo, comando registrado, fixture, log, relatório ou commit.
- **Nenhum segredo real foi usado, gravado ou commitado.**
- **Nenhuma menção a assistente** em código, documentação, mensagens de commit ou autoria.
- **Nenhum comentário novo foi adicionado ao código** além de documentação de contrato e de decisão em JSDoc.
- **Nada foi declarado como concluído sem prova.** Os invariantes 1 a 12 da especificação de 08/09 estão atendidos e cobertos por teste local; os dois defeitos de borda de 09/09 (P0.11 e P0.12) estão cobertos por teste local **e** pela suíte de contrato de §3.1, que foi verificada contra os próprios defeitos. O que depende de dois serviços publicados, de réplicas separadas e do PostgreSQL de dev está registrado em §7 como bloqueio externo, não como aceite.
- **Nenhum provedor externo foi testado de verdade.** A suíte de contrato stuba a geração de texto e o cálculo de embedding: ela prova a fronteira entre os dois serviços, não a chamada a um fornecedor. O aceite do multiprovedor continua dependendo do que está em §7.
