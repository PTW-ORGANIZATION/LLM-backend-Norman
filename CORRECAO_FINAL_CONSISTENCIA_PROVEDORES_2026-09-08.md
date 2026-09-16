# Correção final — consistência de ativação e fallback multiprovedor

**Data:** 08/09/2026  
**Escopo:** LLM-backend e Norman  
**Objetivo:** eliminar os dois defeitos de consistência restantes antes de qualquer push ou publicação em dev.

## 1. Estado de partida obrigatório

### LLM-backend

- Repositório: `/Users/diego.alipio/ptw/LLM-backend-Norman`
- Branch: `feature/formatos-legados-doc-xls-pptx`
- Base que deve permanecer intacta: `aded5b9`
- HEAD auditado: `f6404b38c7ace1ecb5d182d3919c9e0e3b8ad98c`

### Norman

- Repositório: `/Users/diego.alipio/ptw/Norman`
- Branch: `feature/finalizacao-camada-conhecimento`
- Base que deve permanecer intacta: `2af225a`
- HEAD auditado: `fc32b99954c822ccc32fc3516fd18d458d25e1da`

Antes de alterar qualquer arquivo:

1. confirme repositório, branch, HEAD e base;
2. confira o estado do Git;
3. preserve todos os arquivos não rastreados;
4. não restaure, descarte ou sobrescreva mudanças que não pertençam a esta correção;
5. não use nem procure credenciais publicadas em conversas anteriores.

## 2. Invariantes obrigatórios

A solução só está correta se preservar todos estes invariantes, inclusive sob falha de rede, timeout, repetição e concorrência:

1. O Norman nunca pode anunciar uma ativação como vigente antes de o LLM-backend reconhecer a mesma identidade de ativação para a mesma conexão e revisão.
2. Uma falha ou timeout entre os dois serviços não pode trocar silenciosamente a IA usada pelas pessoas.
3. A resposta de erro da rota de ativação não pode deixar uma nova ativação efetiva no Norman.
4. Repetir uma operação com a mesma identidade deve ser idempotente.
5. Duas ativações administrativas concorrentes não podem terminar como vencedoras.
6. O LLM-backend não pode perder uma ativação válida porque uma tentativa posterior gravou outra identidade sobre a mesma revisão.
7. O fallback deve apontar para uma revisão exata, previamente testada e ainda válida — nunca para “a revisão mais nova” de uma chave lógica.
8. Criar ou sincronizar uma revisão nova não pode alterar o fallback já aprovado.
9. O fallback não pode usar a mesma conexão lógica do provedor primário apenas porque os IDs de revisão são diferentes.
10. Falta de confirmação, revisão divergente, teste vencido ou configuração alterada deve falhar de forma fechada, antes de chamar o provedor externo.
11. URL, chave e segredo de provedor continuam existindo apenas no LLM-backend.
12. O caminho legado e o fallback permanecem desligados/inalterados por padrão, conforme a configuração já existente.

## 3. P0.1 — ativação distribuída consistente

### Defeito atual

Em `server/modules/ai-provider-control/ai-provider-control.service.ts`, o Norman chama `repository.activate()` antes de `activateRevisionAtExecutor()`. A primeira chamada já insere a ativação que `latestActivation()` considera vigente. Se a confirmação remota falhar, a rota responde erro, mas o banco do Norman já mudou.

No LLM-backend, a identidade de ativação também não deve continuar como um único campo sobrescrevível na revisão. Uma tentativa posterior não pode invalidar uma ativação anterior válida.

### Resultado exigido

Implemente um protocolo durável de preparação/confirmação. A forma concreta pode variar, mas precisa ter estes elementos:

- uma identidade de ativação criada antes da chamada remota;
- estado explícito no Norman, no mínimo `pending`, `active` e `failed`/`cancelled`;
- somente ativações `active` podem ser retornadas por `latestActivation()` e usadas por `activeSnapshot()`;
- apenas uma ativação pendente concorrente por instalação, com CAS baseado na ativação vigente observada pelo administrador;
- confirmação idempotente no LLM-backend para a tupla exata `activationId + connectionKey + revision`;
- registro de ativações reconhecidas no executor sem sobrescrever vínculos válidos anteriores;
- finalização local somente depois da confirmação remota;
- falha remota marca a tentativa local como falha e mantém a ativação vigente anterior;
- falha local depois da confirmação remota precisa ser recuperável por repetição/reconciliação idempotente, sem interromper a ativação anterior;
- timeout não pode ser interpretado automaticamente como “não executado”; repetir com o mesmo `activationId` deve descobrir/concluir o estado correto;
- cache só pode ser invalidado depois da ativação efetiva.

Use migration aditiva e compatível com o estado atual. Não reescreva o histórico já publicado. Caso crie uma tabela própria de vínculos no LLM-backend, imponha unicidade para a identidade de ativação e para a tupla que o contrato declarar. Não armazene segredo, URL nem corpo de prompt nessa tabela.

### Testes mínimos obrigatórios

Além dos testes existentes, prove:

1. confirmação remota com sucesso torna a mesma ativação vigente nos dois lados;
2. falha remota mantém a ativação anterior vigente no Norman;
3. durante `pending`, `activeSnapshot()` ainda devolve a anterior;
4. retry da mesma identidade depois de timeout é idempotente;
5. confirmação remota seguida de falha na finalização local pode ser reconciliada;
6. duas ativações concorrentes: somente uma vence;
7. vínculo remoto de uma nova tentativa não apaga um vínculo válido anterior;
8. geração aceita apenas uma identidade confirmada para a conexão e revisão informadas;
9. geração com identidade pendente, falha, inventada ou pertencente a outra revisão é recusada antes do adapter;
10. migration sobe sobre banco vazio e sobre o estado produzido pelas migrations atuais.

Não aceite apenas mocks isolados. Inclua teste com PostgreSQL real/embarcado para transação, CAS, índices e migrations. Mantenha também um teste HTTP real cobrindo o contrato Norman → LLM-backend, inclusive uma resposta perdida após a confirmação.

## 4. P0.2 — fallback fixado na revisão testada

### Defeitos atuais

O Norman guarda uma `connectionId` que identifica uma revisão, mas `fallbackForGateway()` envia somente `connectionKey`. O LLM-backend então usa `latestEnabled(connectionKey)`. Como uma revisão nova é sincronizada antes de ser testada e ativada, o fallback pode executar exatamente essa revisão não aprovada.

Além disso:

- ligar o fallback não exige teste recente e aprovado da revisão escolhida;
- a comparação com o primário usa `connectionId`, permitindo selecionar outra revisão da mesma chave lógica como “alternativa”.

### Resultado exigido

- O contrato do fallback deve carregar pelo menos `connectionKey`, `connectionRevision`, `model`, causas permitidas e limite de tentativas.
- O Norman deve obter revisão e modelo da `connectionId` persistida na política, sem recalcular “a mais nova”.
- Ao ligar o fallback, exigir teste `passed` da mesma `connectionId`, dentro do mesmo prazo já usado para ativação.
- Recusar fallback cuja `connection.key` seja igual à chave lógica da conexão primária vigente.
- O LLM-backend deve resolver a revisão exata com o registro de revisões; remover o uso de `latestEnabled()` do caminho de fallback.
- Modelo divergente, revisão inexistente/desabilitada, digest de configuração alterado ou conexão indisponível devem impedir o fallback antes da chamada externa.
- Criar, sincronizar, testar ou ativar uma revisão posterior não pode mudar uma política de fallback existente.
- A auditoria de cada tentativa deve registrar a revisão efetivamente usada, além da chave e do modelo. Atualize contrato, tipos, persistência e migrations se esse campo ainda não existir.

### Testes mínimos obrigatórios

1. fallback usa exatamente a revisão aprovada na política;
2. revisão mais nova reconhecida, mas não testada, não substitui a revisão fixada;
3. revisão mais nova testada também não substitui a política sem nova decisão administrativa;
4. fallback sem teste, com teste falho ou teste vencido é recusado ao configurar;
5. fallback para outra revisão da mesma chave do primário é recusado;
6. revisão fixada inexistente, desabilitada, com modelo divergente ou digest alterado falha antes do adapter;
7. execução e streaming obedecem ao mesmo contrato;
8. auditoria identifica chave, revisão, modelo, número da tentativa e origem do fallback;
9. compatibilidade segura durante publicação desencontrada: combinação de contrato antigo/novo deve falhar explicitamente, nunca escolher uma revisão por aproximação.

## 5. Correção documental pequena

Atualize o comentário em:

`/Users/diego.alipio/ptw/Norman/server/modules/ai/gateway-ai.adapter.ts`

Ele ainda afirma que streaming não existe no gateway, embora a implementação já use o fluxo real. Corrija apenas a documentação, sem mudar o comportamento funcional já aprovado.

## 6. Regressões que não podem ocorrer

Não altere nem simplifique os blocos já aprovados:

- isolamento por cliente;
- contexto e citações do acervo;
- upload administrativo de documentos;
- `.doc`, `.xls`, `.pptx`, `.docx`, `.xlsx`, `.xlsm`, PDF e formatos textuais;
- transcrição de áudio com armazenamento durável, lease, heartbeat, retry e backoff;
- revogação com lápide e proteção contra jobs antigos;
- cancelamento HTTP real de streaming;
- separação entre operações genéricas e vinculadas a cliente;
- segredos externos somente no LLM-backend;
- caminho legado como rollback;
- permissões administrativas existentes.

## 7. Validação completa

### LLM-backend

Execute obrigatoriamente:

```bash
npm run typecheck
npm run build
npm test
```

### Norman

Execute obrigatoriamente:

```bash
npm run check
npm run check:server
npm run build
npm test
npm run test:coverage
```

Também execute:

- `git diff --check` nos dois repositórios;
- busca por segredos reais adicionados no diff;
- migrations contra PostgreSQL real/embarcado;
- os testes HTTP reais do contrato, cancelamento e compatibilidade de versão.

Não declare validação externa que não aconteceu. Se banco, Redis, Ollama ou provedor real não estiver disponível, registre como bloqueio externo, sem converter em aceite.

## 8. Relatório final

Atualize `RELATORIO_AJUSTES_POS_AUDITORIA_2026-09-08.md` com:

- causa dos dois defeitos;
- arquitetura escolhida para ativação distribuída;
- comportamento de recuperação e idempotência;
- contrato exato do fallback;
- migrations criadas;
- testes adicionados e resultados reais;
- riscos e validações externas ainda pendentes;
- hashes finais depois do squash.

Não escreva que “tudo foi fechado” se algum invariante ou teste desta especificação não estiver provado.

## 9. Squash obrigatório e limites de execução

Ao terminar e somente depois de todas as validações locais passarem:

- deixe exatamente **um commit depois de `aded5b9`** no LLM-backend;
- deixe exatamente **um commit depois de `2af225a`** no Norman;
- os commits devem conter todo o trabalho anterior das branches e estas correções;
- preserve as bases indicadas;
- preserve todos os arquivos não rastreados;
- autoria e committer devem usar `admin@ptwag.com`;
- não inclua `Co-authored-by`;
- não mencione Claude, Opus, Codex, assistente ou ferramenta automatizada em commit, código ou relatório;
- mensagens sugeridas:
  - LLM-backend: `feat: conclui gateway multiprovedor e camada de conhecimento`
  - Norman: `feat: conclui controle de provedores e conhecimento de clientes`
- confirme com `git rev-list --count <base>..HEAD` que o resultado é `1` em cada repositório;
- confirme `git diff --check <base>..HEAD` sem saída;
- não faça push;
- não abra pull request;
- não publique em nenhum ambiente;
- não use a chave do Grok nem as credenciais de servidor compartilhadas anteriormente.

## 10. Critério de conclusão

O trabalho só está concluído quando:

1. os doze invariantes da seção 2 estiverem atendidos;
2. todos os testes mínimos das seções 3 e 4 existirem e passarem;
3. as suítes completas continuarem verdes;
4. as migrations tiverem sido exercitadas de verdade;
5. houver exatamente um commit por branch depois das bases;
6. nenhum segredo tiver sido incluído;
7. nenhum push ou deploy tiver sido realizado;
8. o relatório final distinguir claramente prova local de validação externa pendente.
