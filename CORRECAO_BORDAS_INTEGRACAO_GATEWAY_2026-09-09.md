# Correção das bordas de integração do gateway

**Data:** 09/09/2026  
**Escopo:** LLM-backend e Norman  
**Objetivo:** corrigir duas regressões de integração que não aparecem nas suítes isoladas antes de publicar ou testar o gateway em dev.

## 1. Veredito da auditoria

As correções anteriores de ativação em duas fases e fallback fixado por revisão foram implementadas corretamente e passaram nas suítes completas. A auditoria cruzada encontrou, porém, dois bloqueadores adicionais:

1. o token interno do Norman não está autorizado a chamar as operações genéricas que o próprio adapter do Norman produz;
2. `NORMAN_AI_FORCE_CONNECTION` produz uma identidade de ativação fictícia e escolhe uma revisão de forma não determinística, mas o LLM-backend agora exige uma ativação real e confirmada.

Esses dois defeitos podem deixar o código todo verde separadamente e ainda quebrar quando os serviços conversarem de verdade.

## 2. Estado de partida obrigatório

### LLM-backend

- Repositório: `/Users/diego.alipio/ptw/LLM-backend-Norman`
- Branch: `feature/formatos-legados-doc-xls-pptx`
- Base preservada: `aded5b9`
- HEAD auditado: `25da23271c841e2b758a427d514961a23e66d721`
- Estado esperado: exatamente um commit depois da base.

### Norman

- Repositório: `/Users/diego.alipio/ptw/Norman`
- Branch: `feature/finalizacao-camada-conhecimento`
- Base preservada: `2af225a`
- HEAD auditado: `6caba183cf8ae859e4fb2bda825047dd4706f92d`
- Estado esperado: exatamente um commit depois da base.

Antes de editar:

1. confirme branch, HEAD e base nos dois repositórios;
2. preserve todos os arquivos não rastreados;
3. não restaure nem descarte mudanças alheias;
4. não use credenciais, chaves ou acessos compartilhados anteriormente;
5. não faça push ou deploy.

## 3. P0.1 — operações genéricas recusadas pelo token do Norman

### Evidência

No LLM-backend, `src/auth/consumer-registry.ts` autoriza o consumidor `norman` somente para:

- `chat`
- `chat_stream`
- `briefing_final`
- `document_briefing`
- `workflow_briefing`
- `workflow_briefing_stream`
- `job_insights`

No Norman, `server/modules/ai/gateway-ai.adapter.ts` troca automaticamente a operação para a variante genérica quando não existe `clientId`:

- `chat_generic`
- `chat_stream_generic`
- `briefing_final_generic`
- `document_briefing_generic`
- `workflow_briefing_generic`
- `workflow_briefing_stream_generic`

O controller real do LLM-backend rejeita uma operação ausente de `consumer.features`. Portanto, uma conversa válida antes da escolha do cliente chega como `chat_generic` e recebe `403`, embora os testes isolados do adapter e do executor passem.

### Resultado exigido

- Autorize explicitamente no consumidor `norman` todas as variantes genéricas que o adapter dele pode produzir.
- Não abra essas operações para outros consumidores automaticamente.
- Não remova a separação entre operação genérica e operação vinculada ao cliente.
- Não volte a tornar `clientId` opcional numa operação que usa conhecimento do cliente.
- Não use uma regra permissiva como “todo consumidor pode chamar toda feature”.
- Mantenha uma fonte explícita e auditável para a lista de operações do Norman.
- Crie uma verificação que falhe quando o mapa `GENERIC_FEATURE` do Norman produzir uma operação que o consumidor `norman` do executor não aceita.

### Testes obrigatórios

1. Com `INTERNAL_API_TOKEN` válido, uma requisição HTTP real para cada variante genérica do Norman atravessa o `InternalAuthGuard` e a autorização do controller.
2. A mesma chamada com consumidor sem a feature continua recebendo `403`.
3. `chat` com cliente continua exigindo o escopo `client`.
4. `chat_generic` com `clientId` continua sendo recusado pela validação da operação.
5. O adapter do Norman sem cliente produz `chat_generic`; com cliente, produz `chat`.
6. Faça pelo menos um teste de contrato que use o cliente HTTP real do Norman e uma aplicação HTTP real do LLM-backend com o guard real. Stub apenas o provedor final, não a autenticação, a validação ou o controller.

## 4. P0.2 — trava operacional incompatível com ativações confirmadas

### Evidência

Em `server/modules/ai-provider-control/ai-provider-control.service.ts`, quando `NORMAN_AI_FORCE_CONNECTION` está preenchida, `activeSnapshot()` atualmente:

- procura apenas pela chave lógica;
- usa `Array.find()` numa lista que pode conter várias revisões da mesma chave e não possui ordenação por revisão;
- fabrica `activationId` como `forced:<chave>`.

O LLM-backend agora valida toda geração consultando `connection_activations`. A identidade `forced:<chave>` não foi confirmada e não existe nessa tabela. Quando `AI_GENERATION_PATH=gateway`, a trava produz um pedido que o executor recusa antes do provedor.

Mesmo que a identidade fictícia fosse aceita, escolher uma conexão somente pela chave permitiria selecionar uma revisão antiga, nova ou ainda não testada de forma não determinística.

### Resultado exigido

- Não crie exceção no LLM-backend para aceitar `forced:*`.
- Não transforme a trava operacional em bypass de teste, revisão ou confirmação.
- Não escolha revisão com `Array.find()` ou “a mais nova habilitada”.
- `NORMAN_AI_FORCE_CONNECTION=<chave>` deve resolver uma ativação real, já efetiva e confirmada, daquela chave lógica.
- Use o `activationId`, a `connectionId`, a revisão e o modelo reais dessa ativação.
- Se houver várias ativações históricas para a chave, escolha deterministamente a ativação efetiva mais recente segundo o histórico confirmado do Norman.
- Linhas `pending`, `failed` ou `cancelled` nunca podem ser escolhidas.
- Uma conexão/revisão desabilitada não pode ser forçada.
- Se a chave nunca teve ativação confirmada, falhe fechado com erro operacional explícito antes de chamar o gateway.
- A visão administrativa deve continuar mostrando que existe uma trava e qual chave foi solicitada, mas também deve conseguir explicar quando ela não resolve uma ativação válida.
- Preserve a regra atual que impede troca de provedor e modelo pela tela enquanto a trava está ligada.
- A migration do protocolo de ativação já copia o histórico anterior; reutilize essa compatibilidade em vez de inventar outra identidade.

Uma implementação aceitável é adicionar ao repositório do Norman uma consulta específica, por chave lógica, que junte ativações, conexões e intenções, aceite ativações antigas sem intenção e intenções no estado `active`, ordene pelo histórico de ativação e devolva a tupla exata. Não limite a busca às últimas 20 linhas da tela.

### Testes obrigatórios

1. Trava para uma conexão com ativação confirmada envia ao gateway o `activationId` real, a revisão real e o modelo real.
2. O executor aceita esse pedido com seu registro de ativações real.
3. A identidade `forced:<chave>` não aparece mais no contrato nem no código de produção.
4. Duas revisões com a mesma chave: a escolha é determinística e usa a ativação confirmada mais recente, não a ordem do array.
5. Revisão mais nova apenas reconhecida ou testada, mas nunca ativada, não é escolhida.
6. Ativação pendente, falha ou cancelada não é escolhida.
7. Conexão desabilitada não é escolhida.
8. Chave sem ativação confirmada falha antes do cliente do gateway.
9. Ativação legada migrada continua utilizável pela trava.
10. Sem a variável de trava, o comportamento normal permanece byte a byte equivalente.
11. Inclua teste com PostgreSQL real/embarcado para a consulta e teste HTTP real Norman → LLM-backend para a geração forçada.

## 5. P1 — segurança da publicação desencontrada

O contrato de geração subiu de 1 para 2 e o executor recusa a versão antiga. Essa recusa é correta e segura, mas significa que não existe publicação escalonada sem indisponibilidade se o gateway já estiver ativo.

Atualize o relatório e o guia operacional deixando explícito:

1. manter `AI_GENERATION_PATH=legacy` durante a publicação dos dois serviços;
2. publicar e migrar o LLM-backend;
3. publicar e migrar o Norman;
4. validar health, capacidades, revisão e ativação confirmada;
5. somente então mudar `AI_GENERATION_PATH=gateway` e reiniciar o Norman;
6. para rollback, voltar a `legacy` sem reverter migrations;
7. se o gateway já estiver ativo num ambiente, usar janela coordenada ou implementar compatibilidade temporária — não afirmar que a atualização é sem interrupção.

Não volte a aceitar fallback v1 incompleto. O ajuste aqui é operacional/documental, salvo se existir uma solução de compatibilidade que mantenha todos os invariantes de revisão.

## 6. Teste de integração que deve impedir nova reincidência

O relatório atual reconhece que os dois processos reais não foram testados juntos. Crie uma suíte enxuta que exercite a fronteira sem depender de Grok, OpenAI, Ollama, Redis ou infraestrutura remota:

- servidor HTTP real do LLM-backend;
- `InternalAuthGuard`, DTOs, validação e controller reais;
- banco PostgreSQL embarcado para revisões e ativações;
- cliente HTTP e adapter reais do Norman;
- provedor final stubado somente após todas as validações;
- token interno de teste falso.

A suíte deve provar no mínimo:

1. conversa genérica autorizada;
2. conversa por cliente autorizada e isolada;
3. consumidor não autorizado recebe `403`;
4. trava operacional usa ativação confirmada real;
5. ativação fictícia é recusada;
6. contrato v1/v2 desencontrado falha explicitamente;
7. nenhuma URL ou credencial de provedor atravessa o contrato.

Se compartilhar código de teste entre os repositórios não for viável, crie um harness executável documentado na raiz do LLM-backend que suba ambos os lados locais. Não duplique a lógica de autorização num servidor falso, porque foi exatamente essa duplicação que deixou o defeito passar.

## 7. Validações completas

### LLM-backend

```bash
npm run typecheck
npm run build
npm test
```

### Norman

```bash
npm run check
npm run check:server
npm run build
npm test
npm run test:coverage
```

Também execute:

- novas suítes de contrato entre os serviços;
- migrations em PostgreSQL real/embarcado;
- `git diff --check` nos dois repositórios;
- busca no diff por segredos reais;
- verificação de que nenhum teste foi convertido em `skip`.

Números observados pela auditoria antes desta correção:

- LLM-backend: 45 arquivos passaram, 2 ignorados; 688 testes passaram, 16 ignorados.
- Norman: 451 arquivos passaram, 1 ignorado; 11.130 testes passaram, 4 ignorados.
- Cobertura Norman: statements 99,07%; branches 93,62%; functions 98,65%; lines 99,62%.

Não aceite regressão desses resultados nem redução dos pisos de cobertura.

## 8. Relatório

Atualize `RELATORIO_AJUSTES_POS_AUDITORIA_2026-09-08.md` para:

- registrar os dois defeitos desta rodada e suas causas;
- corrigir a contagem do Norman para 451 arquivos passando, se permanecer esse resultado;
- registrar os novos testes e resultados efetivamente executados;
- incluir a ordem segura de publicação do contrato v2;
- continuar distinguindo prova local de validação externa;
- não declarar teste real de provedor externo sem tê-lo feito.

## 9. Squash e limites

Depois de toda a validação:

- LLM-backend: exatamente um commit depois de `aded5b9`;
- Norman: exatamente um commit depois de `2af225a`;
- incorpore as novas correções aos commits únicos já existentes;
- preserve todos os arquivos não rastreados;
- autoria e committer com e-mail `admin@ptwag.com`;
- sem `Co-authored-by`;
- sem referência a Claude, Opus, Codex, assistente ou ferramenta automatizada;
- não faça push;
- não abra pull request;
- não faça deploy;
- não aplique migration remota;
- não use credenciais compartilhadas anteriormente.

Mensagens sugeridas, mantendo as atuais:

- LLM-backend: `feat: conclui gateway multiprovedor e camada de conhecimento`
- Norman: `feat: conclui controle de provedores e conhecimento de clientes`

Confirme ao final:

```bash
# LLM-backend
git rev-list --count aded5b9..HEAD
git diff --check aded5b9..HEAD

# Norman
git rev-list --count 2af225a..HEAD
git diff --check 2af225a..HEAD
```

As contagens devem ser `1` e os `diff --check` não devem produzir saída.

## 10. Critério de conclusão

Só declare concluído quando:

1. o token real do consumidor Norman autorizar todas as operações que seu adapter produz;
2. outros consumidores continuarem limitados às próprias features e escopos;
3. a trava operacional usar exclusivamente uma ativação real, confirmada e determinística;
4. nenhum `forced:<chave>` for enviado ao executor;
5. os testes HTTP com autenticação e controllers reais passarem;
6. as suítes completas e a cobertura passarem;
7. o relatório e a ordem de publicação estiverem corretos;
8. houver exatamente um commit local por repositório depois das bases;
9. nenhum push, deploy, migration remota ou uso de segredo tiver ocorrido.
