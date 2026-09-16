# Handoff para nova janela do Codex — conhecimento, RAG e gateway multiprovedor

**Atualizado:** 09/09/2026  
**Função do próximo chat:** receber a próxima entrega do Claude, auditar o código real nos dois repositórios e dizer se está pronto.  
**Estado:** implementação local em branches próprias, sem push e sem deploy desta versão multiprovedor.

## 1. Como usar este handoff

O novo chat do Codex deve:

1. ler este arquivo inteiro;
2. não editar, publicar ou executar qualquer ação remota ao carregar o contexto;
3. aguardar o usuário colar a próxima resposta do Claude;
4. quando a resposta chegar, não confiar apenas no relatório textual do Claude;
5. inspecionar os dois repositórios, os diffs, as migrations, os testes e o estado Git;
6. rerodar as validações relevantes;
7. verificar principalmente os pontos da seção 12;
8. se ainda houver defeito, criar automaticamente um novo `.md` corretivo e um prompt completo para outra rodada;
9. não fazer push ou deploy sem novo pedido explícito do usuário.

## 2. Objetivo original

O Norman recebe projetos e arquivos. Esses materiais devem ser enviados ao projeto LLM-backend, que usa modelos para estudar os documentos e produzir conhecimento reutilizável pelo Norman.

O conhecimento deve poder ser usado em:

- conversas;
- briefings;
- workflows;
- transformação final de briefing;
- outras gerações ligadas a um cliente.

O isolamento é obrigatório: conhecimento de um cliente nunca pode aparecer para outro.

O caso de aceite inicial usa o cliente de teste `ZZ Teste Conhecimento 20260903` e o documento `knowledge-layer-test.pdf`. A resposta correta contém:

- `ORQUIDEA CROMADA 47`;
- `azul-cobalto`;
- `knowledge-layer-test.pdf`.

O controle de isolamento usa uma conversa limpa no cliente `Elias Teste 2`. Nenhum dos três valores pode aparecer. Se aparecer qualquer um, é indício de vazamento entre clientes e o teste deve parar com preservação dos logs.

## 3. Estado da versão estável anterior

A versão estável anterior da camada de conhecimento foi publicada em dev pela branch `feat/google-drive-migration`.

Decisões preservadas:

- não fazer merge em `develop` apenas para publicar dev;
- não promover para produção ainda;
- não publicar homologação;
- não executar backfill;
- não usar cliente real;
- não alterar prompt ao primeiro sinal de vazamento;
- a validação pela tela exigia login e ainda era o aceite manual final daquela versão;
- produção e homologação permaneceram sem alteração.

Evidências daquela versão:

- workflow de dev verde;
- documento de teste em estado `ready`, com um chunk;
- notas `brand_guide`, `document_summary` e `client_dossier` geradas;
- prompt real e dossiê real testados diretamente contra o Ollama de dev;
- o modelo respondeu corretamente os três valores;
- as notas e o chunk pertenciam somente ao cliente de teste;
- LLM e banco estavam saudáveis.

## 4. Classificação estruturada de identificadores

O defeito original fazia o renderer tentar adivinhar pela forma da string se algo era uma frase-chave. Isso acertava `ORQUIDEA CROMADA 47` por conter dígito, mas falharia com slogans sem dígito ou nomes próprios em caixa alta.

A correção implementada anteriormente:

- criou o campo estruturado `identificadores` no extrator;
- pediu explicitamente códigos, slogans, frases-chave e identificadores literais;
- aumentou as versões de `document_summary` e `client_dossier`;
- fez o renderer usar o campo tipado quando disponível;
- manteve a heurística somente para notas antigas;
- regenerou o dossiê de teste com `identificadores: ['ORQUIDEA CROMADA 47']` e `entidades: []`.

Esse bloco não deve ser desfeito.

## 5. Formatos de conhecimento exigidos

O usuário exigiu suporte a:

- PDF;
- DOC e DOCX;
- XLS, XLSX e XLSM;
- PPTX;
- TXT, TEXT, MD, MARKDOWN, CSV, TSV, JSON, YAML, YML, XML, HTML, HTM e LOG;
- áudio, transcrito no Norman antes de chegar ao LLM-backend.

Imagens soltas e PDF protegido não são o foco atual. Áudio não deve ser tratado como documento textual bruto.

A extensão decide antes do MIME porque Drive e Supabase frequentemente retornam `application/octet-stream`.

## 6. Mudança arquitetural solicitada depois

O usuário alterou o produto para uma arquitetura multiprovedor:

- haverá um seletor administrativo de IA no front-end do Norman;
- somente administradores podem escolher;
- a escolha é global: todos os outros usuários usam a IA escolhida pelo administrador;
- o sistema deve aceitar provedores presentes e futuros por conexão de API;
- áudio é transcrito no Norman;
- existe uma aba administrativa chamada **Conhecimento de IA**;
- dentro dela há **Conhecimentos gerais do cliente** e **Aprendizados por cliente**;
- briefings, workflows e outras gerações por cliente consultam essas fontes;
- exemplos de conhecimento geral incluem fontes, cores, tom e regras da marca;
- conhecimento candidato precisa de aprovação administrativa antes de entrar no acervo oficial;
- a permissão ficou restrita a administradores por enquanto.

O usuário informou que essa versão maior, tratada informalmente como “v2”, deveria ficar em branches separadas da versão estável e não ser publicada/testada em dev antes do momento apropriado.

## 7. Norma arquitetural recebida

Arquivo de referência fornecido pelo usuário:

`/Users/diego.alipio/Downloads/Norma_Arquitetura_LLM_RAG_MultiProvider.pdf`

A arquitetura resultante ficou dividida assim:

- Norman: front-end, autenticação de pessoas, permissões, plano de controle, administração das fontes, transcrição de áudio e decisão global de provedor;
- LLM-backend: gateway de geração, adapters dos provedores, prompts privilegiados, RAG, embeddings, busca, contexto, citações e auditoria de execução;
- segredos e URLs dos provedores externos ficam somente no LLM-backend;
- o contrato entre os dois serviços é interno, autenticado e versionado;
- o caminho legado do Norman permanece como rollback temporário;
- fallback é explícito e desligado por padrão;
- operações genéricas e operações vinculadas a cliente são contratos distintos;
- uma operação vinculada a cliente deve falhar se perder o `clientId`, em vez de responder silenciosamente sem conhecimento.

## 8. Repositórios, branches e commits atuais

### LLM-backend

- Caminho: `/Users/diego.alipio/ptw/LLM-backend-Norman`
- Branch: `feature/formatos-legados-doc-xls-pptx`
- Base preservada: `aded5b9`
- HEAD auditado em 09/09: `25da23271c841e2b758a427d514961a23e66d721`
- Mensagem: `feat: conclui gateway multiprovedor e camada de conhecimento`
- Autoria e committer: `admin@ptwag.com`
- Contagem esperada: `git rev-list --count aded5b9..HEAD` retorna `1`.

### Norman

- Caminho: `/Users/diego.alipio/ptw/Norman`
- Branch: `feature/finalizacao-camada-conhecimento`
- Base preservada: `2af225a`
- HEAD auditado em 09/09: `6caba183cf8ae859e4fb2bda825047dd4706f92d`
- Mensagem: `feat: conclui controle de provedores e conhecimento de clientes`
- Autoria e committer: `admin@ptwag.com`
- Contagem esperada: `git rev-list --count 2af225a..HEAD` retorna `1`.

Os commits foram squashados. Não devem aparecer `Co-authored-by` ou referências a Claude, Opus, Codex ou ferramentas automatizadas.

## 9. Arquivos de planejamento e auditoria existentes

No LLM-backend:

- `PLANO_IMPLEMENTACAO_RAG_MULTIPROVIDER_2026-09-08.md`
- `AJUSTES_POS_AUDITORIA_RAG_MULTIPROVIDER_2026-09-08.md`
- `CORRECOES_FINAIS_E_SQUASH_RAG_MULTIPROVIDER_2026-09-08.md`
- `CORRECAO_FINAL_CONSISTENCIA_PROVEDORES_2026-09-08.md`
- `CORRECAO_BORDAS_INTEGRACAO_GATEWAY_2026-09-09.md`
- `RELATORIO_IMPLEMENTACAO_RAG_MULTIPROVIDER_2026-09-08.md`
- `RELATORIO_AJUSTES_POS_AUDITORIA_2026-09-08.md`
- este handoff.

No Norman:

- `HANDOFF_OPUS_CONHECIMENTO_DE_IA.md`
- `PLANO_CONHECIMENTO_DE_IA.md`.

Vários desses arquivos estão não rastreados. Devem ser preservados. Não use comandos destrutivos nem limpe arquivos não rastreados.

## 10. O que já foi implementado e auditado como correto

### Conhecimento e RAG

- correção da busca SQL de descendentes;
- busca por cliente inteiro baseada em `clientId`, sem inventar raiz pelo nome;
- exclusões de múltiplas raízes;
- distinção entre acervo vazio e indisponível;
- citações e evidências por trecho;
- dossiê atual, ausente ou desatualizado;
- tokens estruturados de marca;
- identificadores estruturados;
- revogação com lápide durável;
- proteção contra job antigo ressuscitar fonte removida;
- upload administrativo de documentos;
- conteúdo e estados das notas na tela;
- conhecimento candidato com aprovação administrativa;
- formatos legados DOC, XLS e PPTX, além dos formatos modernos;
- teste com PostgreSQL embarcado e pgvector.

### Áudio

- transcrição feita no Norman;
- armazenamento durável antes de responder aceite;
- falha de storage devolve erro e não agenda processamento;
- deduplicação considerando o ciclo de vida;
- lease atômico por worker;
- heartbeat de renovação;
- retry com backoff e limite de tentativas;
- retomada depois de reinício;
- descarte do áudio original somente após estado terminal.

### Gateway e provedores

- contrato interno autenticado e versionado;
- adapters compatíveis com protocolo OpenAI Chat;
- Ollama, OpenAI e Grok previstos por conexões provisionadas;
- segredos externos somente no LLM-backend;
- teste de conexão executado no LLM-backend;
- seleção administrativa de modelo por revisão;
- prompts privilegiados no executor;
- operações genéricas separadas das vinculadas a cliente;
- streaming incremental real;
- cancelamento propagado por HTTP;
- fallback explícito, com causas limitadas;
- auditoria por tentativa, incluindo fallback;
- health por camadas;
- retenção configurável;
- caminho legado do Norman como rollback.

## 11. Correções da última rodada que foram confirmadas

### Ativação distribuída

O defeito anterior gravava a nova ativação no Norman antes de o executor confirmá-la. Foi substituído por:

- intenção de ativação com estados `pending`, `active`, `failed` e `cancelled`;
- CAS baseado na ativação que o administrador observou;
- confirmação remota idempotente por `activationId + connectionKey + revision`;
- tabela própria `connection_activations` no LLM-backend;
- marca durável de confirmação remota;
- promoção local somente depois da confirmação;
- reconciliação após timeout ou resposta perdida;
- ativação anterior permanece vigente enquanto a nova está pendente;
- índices únicos para impedir duas vencedoras concorrentes;
- cache invalidado somente após ativação efetiva.

Migrations:

- LLM-backend: `1757700000000-ConnectionActivations.ts`;
- Norman: `0024_ai_activation_protocol.sql`.

Essa arquitetura foi revisada e considerada correta no núcleo.

### Fallback fixado

O defeito anterior fazia o executor escolher a revisão habilitada mais nova. Foi corrigido para:

- a política guardar `connectionId`, `connectionRevision` e `model`;
- exigir teste recente e aprovado da revisão escolhida;
- recusar a mesma chave lógica do primário;
- enviar revisão e modelo exatos no contrato v2;
- resolver a revisão exata no executor;
- impedir revisão posterior de alterar política existente;
- registrar a revisão usada na auditoria.

Essa correção também foi revisada e considerada correta.

## 12. Bloqueadores atuais enviados ao Claude

O Claude recebeu o arquivo:

`/Users/diego.alipio/ptw/LLM-backend-Norman/CORRECAO_BORDAS_INTEGRACAO_GATEWAY_2026-09-09.md`

Ele deve corrigir os itens abaixo.

### P0.1 — consumidor Norman recusa suas próprias operações genéricas

No LLM-backend, `src/auth/consumer-registry.ts` autoriza o consumidor `norman` apenas para as operações vinculadas:

- `chat`
- `chat_stream`
- `briefing_final`
- `document_briefing`
- `workflow_briefing`
- `workflow_briefing_stream`
- `job_insights`

No Norman, `server/modules/ai/gateway-ai.adapter.ts` transforma automaticamente as operações em variantes genéricas quando não há cliente:

- `chat_generic`
- `chat_stream_generic`
- `briefing_final_generic`
- `document_briefing_generic`
- `workflow_briefing_generic`
- `workflow_briefing_stream_generic`

O `InternalGenerationController` recusa uma feature ausente de `consumer.features`. Na integração real, uma conversa sem cliente recebe `403`.

Correção esperada:

- autorizar explicitamente para o consumidor Norman todas as operações que seu adapter produz;
- manter outros consumidores limitados;
- preservar a distinção genérico/cliente;
- testar com guard, validação, controller, cliente e adapter reais.

### P0.2 — trava operacional usa ativação fictícia e revisão ambígua

Quando `NORMAN_AI_FORCE_CONNECTION` está preenchida, `activeSnapshot()` atualmente:

- procura pela chave usando `Array.find()`;
- pode pegar qualquer revisão da mesma chave;
- fabrica `activationId` como `forced:<chave>`.

O LLM-backend agora exige que o `activationId` exista em `connection_activations`. A identidade fictícia é recusada antes do provedor.

Correção esperada:

- não aceitar `forced:*` como bypass no executor;
- resolver no Norman uma ativação real, confirmada e efetiva daquela chave;
- usar o ID, a conexão, a revisão e o modelo reais;
- escolher deterministamente a ativação confirmada mais recente;
- nunca usar revisão apenas reconhecida/testada;
- nunca usar intenção pendente, falha ou cancelada;
- falhar fechado se a chave nunca foi ativada;
- testar a consulta com PostgreSQL e a geração Norman → LLM por HTTP.

### P1 — ordem segura de publicação do contrato v2

O contrato v2 recusa v1. Isso é seguro, mas uma publicação desencontrada interrompe o gateway se ele já estiver ativo.

O roteiro deve exigir:

1. manter `AI_GENERATION_PATH=legacy`;
2. publicar e migrar o LLM-backend;
3. publicar e migrar o Norman;
4. validar health, capacidades, revisão e ativação;
5. só então ativar `gateway`;
6. rollback voltando a `legacy`, sem desfazer migrations.

## 13. Validações independentes já executadas em 09/09

Estas validações foram rerodadas pelo Codex, não apenas copiadas do relatório do Claude.

### LLM-backend

Comando:

```bash
npm run typecheck && npm run build && npm test
```

Resultado:

- typecheck passou;
- build passou;
- 45 arquivos passaram e 2 foram ignorados;
- 688 testes passaram e 16 foram ignorados.

### Norman

Comando:

```bash
npm run check && npm run check:server && npm run build && npm test && npm run test:coverage
```

Resultado:

- checks passaram;
- build passou com avisos preexistentes de chunks e `import.meta` em CJS;
- 451 arquivos passaram e 1 foi ignorado;
- 11.130 testes passaram e 4 foram ignorados;
- statements: 99,07%;
- branches: 93,62%;
- functions: 98,65%;
- lines: 99,62%.

As suítes verdes não provam a integração dos dois pontos da seção 12. Foi exatamente a ausência de teste cruzado com autenticação e controllers reais que deixou os defeitos passarem.

## 14. Checklist para auditar a próxima resposta do Claude

Quando o usuário colar a resposta do Claude, o novo Codex deve conferir:

### Git

- branch correta nos dois repositórios;
- exatamente um commit depois de cada base;
- autoria e committer com `admin@ptwag.com`;
- nenhuma referência a assistentes;
- `git diff --check` limpo;
- arquivos não rastreados preservados;
- nenhum push ou deploy.

### Consumidores e operações

- lista real do consumidor Norman contém todas as operações que o adapter pode produzir;
- variantes genéricas funcionam pelo token normal do Norman;
- outros consumidores continuam restritos;
- `chat_generic` recusa `clientId`;
- `chat` vinculado continua exigindo cliente e escopo;
- existe teste HTTP com `InternalAuthGuard` real.

### Trava operacional

- não existe `activationId: forced:<chave>` no código de produção;
- a trava consulta ativação real por chave;
- a consulta não usa lista limitada às últimas ativações da tela;
- múltiplas revisões têm escolha determinística;
- a revisão mais nova não ativada não é escolhida;
- estados `pending`, `failed` e `cancelled` não são escolhidos;
- conexão desabilitada não é escolhida;
- ausência de ativação confirmada falha antes do gateway;
- ativação legada migrada funciona;
- pedido enviado ao executor usa ID, revisão e modelo reais;
- o executor aceita o pedido no teste HTTP real.

### Não regredir

- ativação em duas fases;
- reconciliação depois de timeout;
- CAS e concorrência;
- fallback fixado em revisão e modelo;
- isolamento de cliente;
- streaming e cancelamento;
- áudio durável;
- formatos legados;
- upload administrativo;
- segredos somente no executor.

### Testes

- rerodar as duas suítes completas;
- números não devem cair sem explicação legítima;
- nenhum teste novo em `skip`;
- cobertura acima dos pisos;
- migrations exercitadas em PostgreSQL real/embarcado;
- contrato entre processos testado sem duplicar a lógica num servidor falso.

## 15. Segurança e credenciais

Foram compartilhadas anteriormente na conversa:

- credenciais de login do Norman;
- senhas de SSH das duas VPSs;
- uma chave de API do Grok.

Nenhum valor deve ser copiado para este documento, commits, logs, comandos ou respostas. Considere esses valores expostos e recomende rotação antes do uso definitivo.

As buscas anteriores não encontraram a chave do Grok ou as senhas de SSH nos commits. Existem credenciais de seed/demonstração preexistentes no repositório Norman; não confundir isso com autorização para publicar ou reutilizar credenciais reais.

## 16. Limites permanentes

- Não fazer push sem pedido explícito do usuário.
- Não fazer deploy sem pedido explícito e uma nova auditoria verde.
- Não aplicar migrations remotamente durante auditoria.
- Não executar backfill.
- Não alterar produção ou homologação.
- Não fazer merge em `develop` para esta publicação.
- Não usar clientes reais nos testes.
- Não usar as credenciais compartilhadas na conversa.
- Não confiar em números ou afirmações do Claude sem verificar no workspace.
- Se houver vazamento entre clientes, parar e preservar evidências.

## 17. Resposta esperada ao carregar este contexto

Antes de o usuário colar a próxima resposta do Claude, o novo chat deve apenas confirmar que:

- leu este handoff;
- entendeu quais são os dois bloqueadores atuais;
- não fez mudanças;
- está aguardando a entrega do Claude para auditar.

Depois que a entrega chegar, deve executar a auditoria completa e responder com um dos dois resultados:

1. **Pronto localmente**, acompanhado das evidências e dos bloqueios externos restantes; ou
2. **Ainda não pronto**, acompanhado dos achados objetivos, de um novo `.md` corretivo e de um prompt completo para o Claude.
