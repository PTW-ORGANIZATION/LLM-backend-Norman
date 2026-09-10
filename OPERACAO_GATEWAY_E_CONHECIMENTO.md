# Operação — gateway de geração e camada de conhecimento

Quem opera este serviço precisa de quatro coisas para não descobrir um problema
pela conversa de um usuário: saber o que cada variável liga, saber o que a saúde
está dizendo, saber o que a retenção está (e não está) limpando, e saber onde
mora cada segredo.

## 1. Onde moram os segredos

As credenciais dos provedores de geração ficam **neste serviço**. O plano de
controle do Norman manda a chave lógica da conexão e a revisão dela; ele nunca
manda URL, chave, prompt de sistema ou nome de modelo fora da allowlist.

| Conexão | URL base | Credencial | Modelo padrão | Allowlist |
| --- | --- | --- | --- | --- |
| `ollama` | `OLLAMA_OPENAI_BASE_URL` | `OLLAMA_API_KEY` (opcional) | `OLLAMA_MODEL` | `OLLAMA_ALLOWED_MODELS` |
| `openai` | `OPENAI_BASE_URL` | `OPENAI_API_KEY` | `OPENAI_MODEL` | `OPENAI_ALLOWED_MODELS` |
| `grok` | `GROK_BASE_URL` | `GROK_API_KEY` | `GROK_MODEL` | `GROK_ALLOWED_MODELS` |

Conexão sem as variáveis necessárias aparece como **indisponível** na
administração, com o nome da variável que falta. Ausência de configuração nunca
aparece como sucesso, e uma variável em branco nunca vira porta aberta.

A allowlist é o que limita a escolha do administrador: modelo fora dela não é
escolhível e não é testável. O modelo em uso entra sempre na lista, para uma
allowlist mal preenchida não impedir voltar ao que já está rodando.

O Norman **não** precisa de nenhuma dessas variáveis. Ele não tem
`GROK_API_KEY` nem `OPENAI_API_KEY`, e removê-las do ambiente dele não impede
testar, escolher modelo nem ativar uma conexão: o que atravessa é metadado
público — disponibilidade, modelo padrão, allowlist e revisões reconhecidas —,
lido de `GET /internal/generation/capabilities`.

O caminho legado do Norman é o rollback da migração e tem configuração própria e
independente (`LEGACY_AI_*`), apontando para o Ollama local. Ele não reutiliza o
cadastro de conexões daqui, e não é um segundo lugar onde provedor externo é
configurado.

## 1.1 Revisões de conexão reconhecidas

`connectionKey` sozinho não decide o que executa. Cada revisão do plano de
controle precisa ser **reconhecida aqui** antes de ser testada ou usada, e o
registro grava de forma imutável o par chave + revisão + modelo + digest da
configuração provisionada.

| Rota | O que faz | O que **não** recebe |
| --- | --- | --- |
| `POST /internal/generation/connections/revisions` | reconhece (ou reconhece de novo) uma revisão | URL, credencial, prompt |
| `POST /internal/generation/connections/activations` | confirma a tupla `activationId + connectionKey + revision` | URL, credencial, prompt |
| `GET /internal/generation/connections/activations/{activationId}` | diz se aquela identidade está confirmada aqui | URL, credencial, prompt |
| `POST /internal/generation/connections/test` | testa exatamente `connectionKey + revision` | URL, credencial, prompt |

Sincronizar de novo com os mesmos valores é idempotente. Sincronizar a mesma
revisão com outro modelo é **recusado**: é assim que a aprovação de um modelo
deixa de virar aprovação de outro. Mudar o provisionamento (credencial, URL ou
allowlist) muda o digest e invalida a revisão já reconhecida — ela precisa de
uma revisão nova.

A geração recusa, **antes de chamar o provedor**:

- revisão inexistente;
- revisão desabilitada;
- revisão de outra conexão;
- modelo divergente do registrado na revisão;
- ativação sem confirmação aqui — inclusive a que o plano de controle deixou
  pendente ou marcou como falha;
- ativação confirmada para outra chave ou outra revisão;
- ativação confirmada sobre outro provisionamento (digest diferente).

### Ativação em duas etapas

A confirmação mora em `connection_activations`, uma linha por identidade, e não
num campo da revisão. Campo é sobrescrevível: a segunda tentativa gravava a
identidade nova por cima, e uma falha depois disso deixava a ativação que estava
valendo sem resolver.

- `activationId` é único: a mesma identidade nunca vale para duas revisões.
- confirmar de novo a **mesma** tupla é idempotente — é assim que uma repetição
  depois de timeout descobre que a chamada anterior chegou;
- confirmar uma identidade nova **não apaga** as anteriores;
- `GET .../activations/{activationId}` responde 404 quando não há confirmação.
  404 é ausência; qualquer outra falha é "não sei", e o plano de controle não
  pode ler uma como a outra.

O registro de execução grava a revisão que foi realmente resolvida — e não a que
veio no corpo. Com fallback, a segunda tentativa roda sobre outra conexão e
outra revisão, e é essa que fica registrada.

### Fallback fixado na revisão

A política de fallback atravessa com `connectionKey`, `connectionRevision`,
`model`, causas permitidas e limite de tentativas. A revisão é resolvida no mesmo
registro da geração primária — nunca "a revisão habilitada mais nova" da chave.
Política ligada sem revisão ou sem modelo é **recusada na validação**, e não
completada por aproximação: era assim que uma revisão só sincronizada, ainda sem
teste, virava o destino do fallback.

## 2. Fronteira de confiança

```
Pessoa autenticada no Norman
   │  o Norman conhece sessão, perfil e permissão
   ▼
Norman  ──(x-internal-token)──►  rotas /internal deste serviço
   │                                │
   │                                ├─ o token diz QUAL APLICAÇÃO chama,
   │                                │  não que a pessoa por trás seja admin
   │                                ├─ valida operação contra a allowlist do consumidor
   │                                ├─ valida escopo (`client` / `person`) do consumidor
   │                                └─ valida formato de cliente, caminho e modelo
   ▼
Provedor de geração (credencial daqui, nunca do Norman)
```

O que este serviço **não** faz: não confere se a pessoa citada em `actor` tem
acesso ao cliente informado. Quem autoriza a pessoa é o Norman, e o `actor` do
corpo serve para auditoria, não como prova de autorização. Se um dia for
preciso validar essa associação aqui de forma independente, o caminho é um
claim assinado pelo Norman ou uma introspecção — e não confiar no campo.

Consumidores novos entram por `INTERNAL_CONSUMERS`, no formato
`nome:VARIAVEL_DO_TOKEN:op1|op2:escopos:cap1|cap2`. Uma aplicação nova não herda
nada: sem operação declarada ela não gera, sem o escopo `client` ela não alcança
conhecimento de cliente, e sem capacidade declarada ela não abre nenhuma rota de
documento, conhecimento ou conexão.

### 2.1 Capacidades das rotas internas

A lista de operações autoriza **gerar**. Ela nunca disse nada sobre administrar
ou consultar acervo, e enquanto as rotas de documento e de conhecimento
confiaram apenas no token, qualquer aplicação com token válido registrava
documento com qualquer `clientId`, injetava conhecimento geral em todos os
clientes e lia o acervo de quem quisesse. A porta de cada rota agora é uma
capacidade declarada nela, conferida antes de qualquer banco, fila, embedding,
extração ou armazenamento.

| Capacidade | O que abre |
| --- | --- |
| `knowledge.client.read` | pesquisa, estado de ingestão, dossiê e visão de um cliente |
| `knowledge.client.write` | registrar, esquecer, renomear, reprocessar e reconsolidar acervo de cliente |
| `knowledge.system.read` | pesquisa, estado de ingestão e visão do acervo geral do sistema |
| `knowledge.system.write` | registrar, esquecer, renomear e reprocessar no acervo geral |
| `documents.extract` | extração de texto de um arquivo enviado |
| `connections.administer` | reconhecer revisão, confirmar ativação, consultar ativação e testar conexão |

O consumidor `norman` recebe todas elas, porque todas são portas que os adapters
dele atravessam. Os demais recebem só o que estiver escrito na declaração.

Duas conferências valem lembrar:

- registrar ou pesquisar com `scope: "system"` exige a capacidade **de
  sistema**, e não a de cliente: quem só escreve no acervo de um cliente não
  passa a escrever no acervo que entra na geração de todos;
- `GET /internal/documents/:id` confere também o nível e o dono da linha
  encontrada — conhecer um UUID não contorna o escopo.

## 3. Contratos e versões

| Contrato | Versão | Onde |
| --- | --- | --- |
| Geração inteira | `contractVersion: 2` | `POST /internal/generation/v1/complete` |
| Geração em fluxo | `contractVersion: 2` | `POST /internal/generation/v1/stream` |
| Teste de conexão | — | `POST /internal/generation/connections/test` |
| Capacidades | — | `GET /internal/generation/capabilities` |

A versão 2 é a do fallback fixado na revisão. Publicação desencontrada falha de
forma explícita nos dois sentidos: um consumidor que ainda mande a versão 1 é
recusado aqui, e um consumidor novo falando com um backend antigo é recusado lá.
Nenhum dos dois resolve o fallback por aproximação.

A versão do contrato de fluxo vai no primeiro evento (`type: "open"`): um
consumidor que não a conheça para na abertura, em vez de interpretar eventos
que não entende no meio de uma resposta.

### 3.1 Ordem segura de publicação do contrato v2

A recusa recíproca da versão é correta e é o que impede o fallback de ser
resolvido por aproximação — mas ela significa que **não existe publicação
escalonada sem indisponibilidade se o gateway já estiver ativo**. Não trate esta
atualização como sem interrupção.

A ordem, com `AI_GENERATION_PATH` como a chave da janela:

1. **Mantenha `AI_GENERATION_PATH=legacy` no Norman** durante toda a publicação.
   Enquanto ele está em `legacy`, a geração não passa pelo gateway e a diferença
   de versão entre os dois serviços não alcança nenhum usuário.
2. Publique o LLM-backend e rode as migrations dele.
3. Publique o Norman e rode as migrations dele.
4. Valide, **antes** de trocar a chave:
   - `GET /health` com `dependencies.database` e `dependencies.queue` em `ok`;
   - `GET /internal/generation/capabilities` respondendo `contractVersion: 2` e
     declarando as operações que o Norman produz, inclusive as genéricas;
   - a revisão que o Norman tem como ativa aparecendo em `recognizedRevisions`
     daquela chave;
   - a ativação vigente do Norman confirmada aqui
     (`GET /internal/generation/connections/activations/<activationId>`
     respondendo 200, e não 404).
5. Só então mude `AI_GENERATION_PATH=gateway` e reinicie o Norman.
6. **Rollback:** volte `AI_GENERATION_PATH=legacy` e reinicie o Norman. Não
   reverta migrations — elas são compatíveis com o caminho legado, e revertê-las
   perderia o histórico de ativação que o protocolo de duas fases usa.
7. Se o gateway **já estiver ativo** num ambiente, a atualização exige janela
   coordenada — os dois serviços publicados juntos — ou uma compatibilidade
   temporária que preserve todos os invariantes de revisão. Não existe uma
   terceira opção: aceitar de novo um fallback v1 sem revisão fixada faria o
   executor escolher a revisão por aproximação, que é exatamente o defeito que a
   versão 2 fechou.

Duas travas operacionais nessa janela:

- `NORMAN_AI_FORCE_CONNECTION=<chave>` só funciona se aquela chave lógica tiver
  uma ativação **confirmada** no histórico do Norman e reconhecida aqui. Sem
  isso a trava falha fechada, com erro explícito, antes de chamar o gateway — e
  a tela administrativa do Norman mostra a chave travada e o motivo de ela não
  resolver.
- Trocar de provedor ou de modelo pela tela continua recusado enquanto a trava
  está ligada.

## 4. O que a saúde está dizendo

`GET /health` é aberta e por isso não devolve versão, host, nome de banco, URL
nem nome de variável. Ela separa as camadas porque cada uma quebra sozinha e
exige uma ação diferente:

| Campo | Significa | O que fazer quando falha |
| --- | --- | --- |
| `dependencies.database` | Postgres respondendo | verificar o banco; nada de reiniciar o processo |
| `dependencies.queue` | Redis das filas respondendo | verificar Redis e `REDIS_DB` do ambiente |
| `dependencies.gateway` | há ao menos uma conexão provisionada | provisionar uma conexão (§1) |
| `gateway.connections[]` | quais chaves estão provisionadas | idem, por conexão |
| `retention.pendingDecision` | sujeitos sem prazo decidido | decidir o prazo (§5) |

O provedor **não** é sondado aqui: alcançá-lo custa uma chamada paga a cada
verificação de saúde. Quem quer essa resposta usa o teste administrativo de
conexão, que é deliberado e roda por este serviço — o mesmo resolver, o mesmo
adapter, a mesma rede e a mesma política da geração real.

## 5. Retenção

Não há prazo padrão, de propósito. Prazo de retenção é decisão de quem responde
pelos dados, e um número inventado aqui decidiria no lugar dessa pessoa.

| Sujeito | Variável | Limpo por |
| --- | --- | --- |
| Auditoria de geração | `RETENTION_GENERATION_AUDIT_DAYS` | este serviço |
| Conversas e mensagens | `RETENTION_CONVERSATION_DAYS` | este serviço |
| Áudio temporário | `RETENTION_TEMPORARY_AUDIO_DAYS` | Norman |
| Transcrição | `RETENTION_TRANSCRIPT_DAYS` | Norman |

**Sujeito sem prazo não é varrido.** A limpeza daquele sujeito fica desligada, a
pendência aparece em `/health` e no log da subida, e nada é apagado. Preencher a
variável é o que liga a limpeza.

A varredura roda a cada `RETENTION_SWEEP_INTERVAL_MS`, remove no máximo
`RETENTION_BATCH_SIZE` linhas por tabela e é idempotente: o que passou do prazo
continua passado no tique seguinte, e rodar em mais de uma réplica não estraga
nada.

## 6. Separação de ambientes

Duas instâncias no mesmo Redis com o mesmo `REDIS_DB` compartilham as filas do
BullMQ e roubam job uma da outra — a de produção buscaria no Norman de produção
um arquivo que só existe no de develop. Use um índice por ambiente.

`REDIS_PASSWORD` vazia só é aceitável num Redis que não sai de localhost: a fila
carrega identificador de documento e de cliente.

## 7. Antes de reiniciar

A validação de deploy deve falhar **antes** do restart quando a conexão ativa
não puder ser resolvida. O que checar, nesta ordem:

1. `GET /health` responde e `dependencies.database` está `ok`;
2. `dependencies.queue` está `ok`;
3. a conexão que o Norman tem como ativa aparece em `gateway.connections` com
   `provisioned: true`;
4. o teste administrativo dessa conexão passou recentemente (a administração do
   Norman mostra a idade do último teste e recusa ativar com teste vencido).

Subir com a conexão ativa não resolvível deixa o produto sem geração, e o
sintoma aparece na conversa de um usuário — não no deploy.

## 8. Migração do nível de acervo e o acervo geral

A coluna `knowledge_scope` (`KnowledgeScopeLevels1757800000000`) é o
discriminador persistido dos três níveis. Duas coisas importam na operação:

**A reversão deixa de ser possível depois que o acervo geral recebe conteúdo.**
O modelo anterior não sabe representar uma linha `system`: `client_id` volta a
ser obrigatório em notas e lápides, e documento sem cliente não satisfaz o CHECK
antigo. Com zero linha `system`, o `down()` desce normalmente. Com qualquer
linha `system`, ele **falha antes de excluir qualquer coisa** e diz quantos
documentos, trechos, notas e revogações existem. Nenhuma linha de cliente ou de
pessoa é tocada nessa recusa.

Isto é uma recusa deliberada, e não um defeito: a alternativa era apagar o
acervo geral em silêncio numa operação que ninguém pediu para ser destrutiva.
Para reverter mesmo assim, é preciso exportar essas linhas e removê-las por
decisão operacional explícita antes de rodar a reversão. Não chame essa
reversão de "segura": ela descarta o acervo geral.

**Os CHECKs recusam dono incompatível com o nível.** Nos níveis `client` e
`system`, `user_id`, `organization_id` e `project_id` precisam ser nulos; no
nível `person`, `user_id` e `organization_id` são obrigatórios e `project_id`
continua opcional. Uma linha não consegue declarar-se geral e ainda carregar
dono organizacional residual.

## 9. Fonte geral aguardando registro no acervo

O acervo de cliente entra por varredura do repositório; o acervo geral não tem
varredura que o reconheça, e por isso o Norman registra cada fonte geral por uma
chamada explícita a `POST /internal/documents` com `scope: "system"`.

Essa chamada é uma etapa durável do lado do Norman. Uma fonte geral guardada e
ainda não registrada aparece na aba de administração com o aviso de registro
pendente e o botão **Registrar no acervo**, que refaz a etapa sem reenviar o
arquivo. O worker de recuperação também a retoma sozinho, com espera crescente
e arrendamento — duas réplicas não anunciam a mesma fonte.

Enquanto o registro não fecha, a fonte **não** participa de geração nenhuma. Se
o aviso persistir, o que checar é a alcançabilidade deste serviço a partir do
Norman e o motivo da última falha, que fica gravado na própria ficha.
