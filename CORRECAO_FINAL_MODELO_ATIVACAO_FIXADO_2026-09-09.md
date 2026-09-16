# Correção final — modelo fixado pela ativação confirmada

**Data:** 09/09/2026  
**Estado da auditoria:** ainda não pronto  
**Escopo:** Norman e teste de contrato Norman ↔ LLM-backend  
**Publicação:** proibidos push, deploy, migration remota e backfill

## 1. Resultado preservado

Os dois bloqueadores anteriores avançaram corretamente:

- o token do Norman passou a autorizar todas as operações genéricas produzidas pelo adapter;
- outros consumidores continuam limitados às operações e aos escopos declarados;
- `NORMAN_AI_FORCE_CONNECTION` passou a selecionar uma ativação local efetiva por chave, sem fabricar `forced:<chave>`;
- a seleção por chave usa o histórico completo, ordenação determinística e exclui intenções `pending`, `failed` e `cancelled` e revisões desabilitadas;
- a suíte HTTP cruzada usa guard, validação, controller, cliente, adapter e dois bancos PostgreSQL embarcados reais;
- as suítes completas, cobertura e migrations passaram.

Não refazer esses blocos e não reduzir sua cobertura.

## 2. Bloqueador objetivo restante

### P0 — o modelo da ativação confirmada é lido e depois descartado

No Norman, `latestConfirmedActivationForKey()` devolve a tupla local da ativação, incluindo:

- `activationId`;
- `connectionId`;
- `connectionKey`;
- `connectionRevision`;
- `model` gravado na intenção confirmada.

Porém `forcedSnapshot()` usa apenas o ID da ativação e a linha da conexão. O campo `confirmada.model` nunca entra no snapshot. Em vez disso, `auditProviderOf()` chama `modelOf()`, que escolhe `selectedModel` ou o **modelo padrão atual** anunciado pelo executor.

O caminho normal de `activeSnapshot()` usa o mesmo recálculo. Em ambos os casos, `server/bootstrap/module-composition.ts` envia `snapshot.provider.model` no contrato de geração.

Isso viola a exigência de enviar ID, revisão e modelo da mesma ativação real e fixada. Se o modelo padrão provisionado mudar depois da ativação, mantendo os dois modelos na allowlist, o Norman envia a identidade e a revisão antigas junto do modelo padrão novo. O executor então recusa corretamente o pedido por divergência de modelo antes de chamar o provedor.

### Evidência de código

- `Norman/server/modules/ai-provider-control/ai-provider-control.repository.ts:69-105` lê e devolve `intentModel` como `model`;
- `Norman/server/modules/ai-provider-control/ai-provider-control.service.ts:281-310` não usa `confirmada.model` e recalcula o modelo por `auditProviderOf()`;
- `Norman/server/modules/ai-provider-control/ai-provider-control.service.ts:313-339` faz o mesmo no caminho não forçado;
- `Norman/server/bootstrap/module-composition.ts:158-165` envia esse valor recalculado ao gateway;
- `LLM-backend-Norman/src/gateway/connection-revisions.service.ts:285-290` recusa um modelo diferente do fixado na revisão;
- `LLM-backend-Norman/src/gateway/connection-revisions.service.ts:305-329` também confere a ativação contra o modelo e o digest confirmados.

### Reprodução independente

Foi instanciado o serviço com:

- ativação real `act-real`, revisão 1, modelo confirmado `modelo-ativado`;
- mesma conexão sem `selectedModel`;
- capacidades atuais do executor com `defaultModel: modelo-atual` e allowlist contendo os dois modelos.

Resultado observado:

```text
{"modeloConfirmado":"modelo-ativado","modeloEnviado":"modelo-atual","activationId":"act-real","revision":1}
```

O teste de contrato atual não captura a divergência porque confirma e executa com o mesmo modelo padrão corrente. Ele também não compara o modelo devolvido por `latestConfirmedActivationForKey()` com o modelo efetivamente enviado.

## 3. Correção obrigatória

1. Faça o snapshot usar a tupla da ativação confirmada, sem recalcular o modelo a partir do padrão atual da conexão.
2. Para execução via gateway, obtenha ou valide a confirmação real do executor por `activationId`; a resposta de `describeActivationAtExecutor()` já contém `connectionKey`, `revision` e `model` exatos.
3. Confirme deterministicamente que a ativação remota corresponde à chave e à revisão da ativação efetiva local.
4. Use o modelo fixado nessa confirmação para o pedido de geração e para a auditoria.
5. Se a confirmação remota estiver ausente, indisponível ou divergente, falhe fechado antes de chamar o gateway. Não caia para `defaultModel`, revisão mais nova, ativação anterior aproximada ou `forced:*`.
6. Preserve ativações legadas migradas. O teste precisa executar as migrations reais dos dois lados e provar como o modelo exato é recuperado sem aproximação.
7. Aplique o mesmo invariante ao caminho normal e ao caminho com `NORMAN_AI_FORCE_CONNECTION`, pois ambos alimentam `resolveActivation()` com `snapshot.provider.model`.
8. Não altere fallback, autorização genérica, isolamento, streaming, cancelamento, áudio ou formatos legados além do necessário.
9. Não adicione comentários ao código. Não remova comentários existentes fora do trecho inevitavelmente alterado.

## 4. Testes obrigatórios

### Norman

- teste unitário no qual o modelo gravado/confirmado é `modelo-ativado`, o padrão atual do executor é `modelo-atual`, a allowlist contém ambos e o snapshot continua usando `modelo-ativado`;
- o mesmo caso para ativação normal e forçada;
- confirmação remota ausente retorna erro fechado antes do cliente de geração;
- confirmação remota com chave ou revisão divergente retorna erro fechado;
- conexão/revisão desabilitada continua recusada;
- ativação legada migrada continua funcionando com o modelo exato.

### Contrato Norman ↔ LLM-backend

Amplie a suíte real para:

1. sincronizar e confirmar uma ativação com `modelo-A`;
2. mudar o modelo padrão corrente/capacidades para `modelo-B`, mantendo A e B permitidos e sem criar/ativar uma revisão nova;
3. gerar pelo caminho normal e pela trava operacional;
4. provar que o pedido continua levando `modelo-A` e que o executor o aceita;
5. provar que a regressão para o recálculo do padrão atual faz o teste falhar.

O teste deve continuar usando o `InternalAuthGuard`, `ValidationPipe`, controller, `GenerationService`, cliente e adapter reais e os bancos PostgreSQL embarcados. Não replique a regra em servidor falso.

### Regressão completa

Rode novamente:

```bash
cd /Users/diego.alipio/ptw/LLM-backend-Norman
npm run typecheck
npm run build
npm test
npm run test:contract

cd /Users/diego.alipio/ptw/Norman
npm run check
npm run check:server
npm run build
npm test
npm run test:coverage
```

Não aceite teste novo em `skip`. Exercite as migrations reais em PostgreSQL embarcado.

## 5. Regras de Git e segurança

- LLM-backend: branch `feature/formatos-legados-doc-xls-pptx`, base `aded5b9`;
- Norman: branch `feature/finalizacao-camada-conhecimento`, base `2af225a`;
- preserve todos os arquivos não rastreados, inclusive este documento;
- mantenha exatamente um commit depois de cada base, emendando os squashes existentes;
- autoria e committer devem usar `admin@ptwag.com`;
- não inclua `Co-authored-by` nem referência a Claude, Opus, Codex ou ferramenta automatizada nos commits;
- procure segredos no diff e nos commits;
- `git diff --check` deve ficar limpo;
- não faça push, deploy, migration remota ou backfill;
- não use credencial compartilhada anteriormente.

## 6. Prompt completo para a próxima rodada do Claude

Leia integralmente, antes de alterar qualquer arquivo:

`/Users/diego.alipio/ptw/LLM-backend-Norman/HANDOFF_CODEX_AUDITORIA_MULTIPROVEDOR_2026-09-09.md`

`/Users/diego.alipio/ptw/LLM-backend-Norman/CORRECAO_FINAL_MODELO_ATIVACAO_FIXADO_2026-09-09.md`

Há um único bloqueador restante. A autorização das operações genéricas e a seleção de uma ativação local real pela trava avançaram corretamente e devem ser preservadas. O defeito é que o Norman lê o modelo gravado na ativação confirmada, mas `forcedSnapshot()` o descarta e recalcula `snapshot.provider.model` a partir de `selectedModel` ou do `defaultModel` atual do executor. O caminho normal de `activeSnapshot()` faz o mesmo. Se o padrão muda mantendo o modelo antigo permitido, o Norman envia activationId/revisão antigos com modelo novo e o executor recusa a geração.

Corrija o invariante completo: o pedido precisa usar activationId, chave, revisão e modelo da mesma ativação real confirmada. Use e valide `describeActivationAtExecutor(activationId)` para obter a confirmação exata do executor; confira chave e revisão contra a ativação efetiva local; use o modelo confirmado, nunca o padrão corrente. Falhe fechado se a confirmação estiver ausente, indisponível ou divergente. Preserve o funcionamento das ativações legadas migradas e aplique o mesmo critério aos caminhos normal e forçado.

Acrescente testes unitários e de contrato que confirmem `modelo-A`, mudem apenas o padrão atual para `modelo-B` mantendo ambos na allowlist, e provem que tanto a ativação normal quanto `NORMAN_AI_FORCE_CONNECTION` continuam enviando `modelo-A` e sendo aceitas pelo executor. O teste cruzado deve manter guard, validação, controller, serviço, cliente, adapter e bancos PostgreSQL embarcados reais. Prove também que voltar ao recálculo pelo padrão atual faz o novo teste falhar.

Não adicione comentários ao código. Não refaça o que já passou. Preserve P0.1, ativação em duas fases, reconciliação, CAS, fallback fixado, isolamento, streaming, cancelamento, áudio e formatos legados. Rerode integralmente as validações listadas na seção 4. Preserve todos os arquivos não rastreados. Emende os dois squashes para continuar existindo exatamente um commit sobre cada base, com `admin@ptwag.com`, sem referências a assistentes e sem segredos. Não faça push, deploy, migration remota ou backfill. Ao final, relate hashes, contagem de commits, arquivos alterados, testes e cobertura, além da evidência do cenário modelo-A/modelo-B.
