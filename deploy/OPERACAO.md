# Operação do backend de IA

Data desta revisão: 08/09/2026.
Escopo: `LLM-backend-Norman`, com as variáveis do `Norman` que atravessam a fronteira dos dois
serviços. Nenhum valor de segredo aparece aqui — só o nome da variável e o que ela decide.

## 1. Ambientes

Três ambientes, um `.env` por VPS. O `deploy/deploy.sh` recusa publicar quando o cabeçalho
`# AMBIENTE SERVIDO:` do `.env` discorda de `NORMAN_INTERNAL_URL`, porque foi exatamente essa
divergência que apontou develop para produção em 03/09.

| Ambiente | `NORMAN_INTERNAL_URL` | Observação |
| --- | --- | --- |
| develop | `https://dev.normanapp.com` | banco e Redis próprios; `REDIS_DB` distinto |
| homologation | `https://hml.normanapp.com` | idem |
| production | `https://normanapp.com` | idem |

`REDIS_DB` diferente por ambiente não é preferência: duas instâncias no mesmo índice compartilham
as filas do BullMQ e uma rouba job da outra, indo buscar no Norman errado um arquivo que só existe
no outro.

## 2. Variáveis por assunto

### Serviço e integração

| Variável | Serviço | O que decide |
| --- | --- | --- |
| `PORT`, `HOST` | LLM-backend | onde o processo escuta |
| `DB_HOST`, `DB_PORT`, `DB_USERNAME`, `DB_PASSWORD`, `DB_DATABASE` | LLM-backend | Postgres com pgvector |
| `REDIS_HOST`, `REDIS_PORT`, `REDIS_PASSWORD`, `REDIS_DB` | LLM-backend | filas de ingestão e de estudo |
| `INTERNAL_API_TOKEN` | ambos | credencial de serviço das rotas `/internal`. Sem ela, nenhuma chamada interna é aceita |
| `NORMAN_INTERNAL_URL` | LLM-backend | onde buscar os bytes de um arquivo do repositório |
| `LLM_BACKEND_URL` | Norman | onde está o backend de IA |

### Geração

| Variável | Serviço | O que decide |
| --- | --- | --- |
| `AI_GENERATION_PATH` | Norman | `legacy` (padrão) ou `gateway`. É o interruptor da migração e o rollback |
| `GATEWAY_TIMEOUT_MS` | LLM-backend | teto de uma chamada ao provedor |
| `OLLAMA_OPENAI_BASE_URL`, `OLLAMA_API_KEY`, `OLLAMA_MODEL`, `OLLAMA_ALLOWED_MODELS` | LLM-backend | conexão Ollama |
| `OPENAI_BASE_URL`, `OPENAI_API_KEY`, `OPENAI_MODEL`, `OPENAI_ALLOWED_MODELS` | LLM-backend | conexão OpenAI |
| `GROK_BASE_URL`, `GROK_API_KEY`, `GROK_MODEL`, `GROK_ALLOWED_MODELS` | LLM-backend | conexão xAI |
| `NORMAN_AI_FORCE_CONNECTION` | Norman | trava operacional: fixa a conexão e bloqueia troca pela tela |

A ausência de uma dessas variáveis faz a conexão aparecer como **indisponível**, com o nome da
variável que falta, em `GET /internal/generation/capabilities`. Nunca como sucesso.
`*_ALLOWED_MODELS` é a allowlist de modelos que o administrador pode escolher; sem ela, só o modelo
em uso é escolhível.

### Conhecimento

| Variável | O que decide |
| --- | --- |
| `OLLAMA_HOST`, `OLLAMA_EMBEDDING_MODEL`, `OLLAMA_VISION_MODEL` | embedding, estudo e OCR |
| `INGESTION_MAX_FILE_BYTES`, `INGESTION_MAX_EXPANDED_FILE_BYTES` | tetos de tamanho; acima deles o worker morre por OOM |
| `INGESTION_MAX_SHEETS`, `INGESTION_MAX_SLIDES`, `INGESTION_OCR_MAX_PAGES`, `INGESTION_SLIDE_OCR_MAX_IMAGES` | tetos de estrutura; OCR custa mais de um minuto por página |
| `INGESTION_CHUNK_SIZE`, `INGESTION_CHUNK_OVERLAP`, `INGESTION_EMBED_BATCH_SIZE` | forma dos chunks |
| `KNOWLEDGE_DOSSIER_DELAY_MS` | janela de agrupamento do dossiê |
| `KNOWLEDGE_RETRIEVAL_MIN_SIMILARITY`, `KNOWLEDGE_RETRIEVAL_MAX_CHARS`, `KNOWLEDGE_RETRIEVAL_MAX_SNIPPETS` | orçamento de contexto da recuperação |

Trocar `OLLAMA_EMBEDDING_MODEL` **não** é mudança de configuração: os vetores gravados são do modelo
anterior, e a busca passa a ignorá-los (o filtro por `embedding_model` existe justamente para não
misturar dimensões incompatíveis). Trocar exige reindexação controlada, que não está automatizada.

### Reuso por outra aplicação

| Variável | O que decide |
| --- | --- |
| `INTERNAL_CONSUMERS` | lista `nome:VARIAVEL_DO_TOKEN:op1\|op2:escopos` das aplicações além do Norman |
| a variável nomeada em cada entrada | o token daquela aplicação |

O token nunca fica no valor de `INTERNAL_CONSUMERS`, só o nome da variável que o guarda. Aplicação
sem `client` entre os escopos não alcança conhecimento por cliente.

### Retenção

| Variável | Sujeito |
| --- | --- |
| `RETENTION_TEMPORARY_AUDIO_DAYS` | material temporário da transcrição |
| `RETENTION_TRANSCRIPT_DAYS` | transcrição gravada |
| `RETENTION_CONVERSATION_DAYS` | histórico de conversa |
| `RETENTION_GENERATION_AUDIT_DAYS` | auditoria de execução da geração |

**Não há padrão, de propósito.** Prazo de retenção é decisão de quem responde pelos dados, e um
número inventado aqui decidiria no lugar dessa pessoa; guardar para sempre em silêncio também não
serve. Enquanto o prazo não for decidido, `GET /health` lista o sujeito em
`retention.pendingDecision` — a pendência fica visível para quem opera, e o descarte automático não
existe até ela ser resolvida.

## 3. Publicação e rollback

Publicar é `./deploy/deploy.sh` na VPS, como o usuário dono do serviço. `--check` confere sem
publicar. O script confere o `.env`, aplica migrações, constrói, reinicia pelo PM2 e só considera
publicado depois de `GET /health` responder.

Rollback da migração da geração: `AI_GENERATION_PATH=legacy` no `.env` do Norman e reiniciar. A
orquestração volta para `server/gemini.ts` sem reverter migração nenhuma — todas as colunas
adicionadas são aditivas e opcionais, e a versão anterior do código as ignora.

Rollback de versão: `git reset --hard` para a tag anterior e repetir o `deploy.sh`. As migrações
desta entrega têm `down`, mas o caminho de volta preferido é manter o schema e trocar o código: as
colunas novas não incomodam a versão antiga.

Ordem entre os dois serviços: **backend de IA primeiro**, Norman depois. As respostas novas são
aditivas e o adapter do Norman tolera resposta sem os campos novos, o que permite subir o Norman
contra um backend ainda não atualizado. O inverso não vale: um Norman novo pedindo o contrato de
geração a um backend antigo recebe 404, e é por isso que `AI_GENERATION_PATH` só vira `gateway`
depois de o backend estar publicado.

## 4. Saúde, filas e falhas

- `GET /health` (aberta, sem credencial): estado do banco, uptime e as pendências de retenção. Não
  devolve versão, host, nome de banco nem mensagem de driver.
- `GET /internal/generation/capabilities` (token interno): versão do contrato, operações da
  aplicação que chamou, conexões e o motivo de cada indisponibilidade.
- Filas: `ingestion` e `knowledge`, no Redis, com concorrência separada
  (`INGESTION_QUEUE_CONCURRENCY`, `KNOWLEDGE_QUEUE_CONCURRENCY`). A ingestão anda mais devagar de
  propósito: ela disputa a mesma GPU do chat interativo.
- Falha de ingestão fica no documento (`documents.status = 'failed'` com `failure_reason`) e aparece
  na tela de conhecimento do cliente. Ela não vira erro na tela de quem enviou o arquivo.
- Execução da geração fica em `generation_executions`, uma linha por tentativa, com a correlação, a
  conexão efetiva, a latência e as evidências. Prompt, documento e transcrição não são gravados.

### O que vale alertar

| Sinal | Onde olhar | Por que importa |
| --- | --- | --- |
| `/health` degradado | banco | o serviço está no ar sem responder consulta |
| fila de ingestão parada com job pendente | Redis, PM2 | arquivo enviado que nunca vira conhecimento |
| `documents.status = 'failed'` crescendo | tela de conhecimento | formato novo ou arquivo protegido chegando ao acervo |
| `generation_executions` com `status = 'failed'` em série | conexão do provedor | provedor fora, ou credencial trocada |
| `generation_executions` com `fallback_of` preenchido | política de fallback | dados foram para outro fornecedor |
| `knowledge_notes.stale_since` antigo | fila de dossiê | derivado fora de circulação sem recálculo |
| `knowledge_sources.revocation_state = 'failed'` | remoção de fonte | fonte revogada com invalidação não confirmada |
| `retention.pendingDecision` não vazio | esta página | prazo de retenção ainda não decidido |

Nada aqui está automatizado como alerta: a tabela diz o que observar, e montar a coleta é etapa
operacional.

## 5. O que continua fora do código

- **Prazo de retenção**: decisão de quem responde pelos dados.
- **Não treinamento pelos provedores externos**: depende da conta, da configuração e dos termos
  aplicáveis do fornecedor. Nenhum parâmetro deste serviço substitui isso.
- **Separação das VPS, endpoints expostos e autenticação do Redis**: etapa operacional autorizada.
  O `REDIS_PASSWORD` existe na configuração; exigi-lo no servidor é ação na VPS.
- **Reindexação por troca de modelo de embedding**: preparada pelo filtro de procedência, não
  automatizada.
- **Integração do Niprofe**: o contrato por aplicação existe e é testado com um consumidor
  fictício. Ligar o produto de verdade depende do repositório e do contrato dele.
