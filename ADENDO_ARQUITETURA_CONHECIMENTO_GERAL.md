# Adendo arquitetural — conhecimento geral do sistema e conhecimento do cliente

**Data:** 09/09/2026
**Escopo:** `LLM-backend-Norman` e `Norman`
**Estado:** implementação local, sem push, deploy, migration remota ou backfill

Este adendo fecha as ambiguidades que os materiais anteriores deixaram abertas.
Onde ele contradiz um diagrama, vale este documento.

## 1. Os dois níveis, e por que são dois

| | **Conhecimento geral do sistema** | **Conhecimento geral do cliente** |
| --- | --- | --- |
| Dono | ninguém (nível `system`, `clientId` nulo) | um cliente (nível `client`, `clientId` obrigatório) |
| Quem administra | administrador com acesso transversal a clientes | administrador do cliente, dentro do escopo dele |
| Onde aparece | nas gerações **vinculadas a cliente**, de todos os clientes | só nas gerações daquele cliente |
| Onde o arquivo fica | `_Conhecimento geral do sistema/` na raiz do repositório | `<cliente>/Conhecimentos gerais do cliente/` |
| Dossiê consolidado | não tem | tem |
| Tokens de marca | não tem | tem |

São **dois escopos de dado e de autorização**, e não dois rótulos da mesma
coisa. Uma regra de tom de voz do Norman vale para todo cliente; a cor
institucional de um cliente vale só para ele, e vazá-la é o defeito que a
camada de isolamento existe para impedir.

## 2. Matriz de visibilidade

| Operação | Camada `system` | Acervo do cliente A | Acervo do cliente B |
| --- | --- | --- | --- |
| Geração vinculada ao cliente A | **sim** | **sim** | não |
| Geração vinculada ao cliente B | **sim** | não | **sim** |
| Operação genérica (antes da escolha do cliente) | não | não | não |
| Escopo pessoal (chat de pessoa do LLM-backend) | não | não | não |

A operação genérica **não** consulta a camada geral nesta rodada. Se o produto
decidir que ela pode, isso é uma decisão explícita com operação e testes
próprios — não um efeito colateral de a camada geral existir.

## 3. Precedência: cliente sobre sistema

Quando as duas camadas se contradizem, **vale a do cliente**. A precedência é
imposta em três lugares, e não só declarada em prosa:

1. **Ordem.** Os trechos do cliente entram no contexto antes dos gerais.
2. **Orçamento.** O limiar de evidência e o teto de contexto são aplicados por
   camada e depois na mesclagem; quando o espaço acaba, é o trecho geral que
   fica de fora.
3. **Cabeçalho.** O bloco de contexto diz, no texto que o modelo lê, que a regra
   do cliente prevalece — e cada trecho vem marcado com `[cliente]` ou
   `[sistema]`.

## 4. O que decide o nível: metadado, nunca caminho

O nível é a coluna `knowledge_scope`, persistida em `documents`,
`document_chunks`, `knowledge_notes` e `knowledge_revocations` no LLM-backend, e
em `knowledge_sources` no Norman. O CHECK do banco exige o dono de cada nível:
`client` com cliente, `system` **sem** cliente, `person` com pessoa e
organização.

O que **não** decide nível, em nenhum ponto do código:

- ausência de `clientId` — omissão nunca compartilha nada, e o campo ausente
  vale `client`, que é o nível estreito;
- `clientId` sintético, reservado ou mágico — recusado na validação do contrato
  interno, no serviço e no CHECK do banco;
- nome ou caminho de pasta — a pasta `_Conhecimento geral do sistema/` é
  **organização operacional**, para o administrador achar o material. A
  varredura do repositório não ingere nada de lá, e o acervo geral entra
  somente pela porta administrativa explícita, que declara o nível;
- consulta sem filtro — a camada geral tem filtro próprio
  (`knowledge_scope = 'system'`), e as duas camadas são **duas consultas**
  separadas, nunca uma união solta.

A conferência de caminho que existe — `isSystemKnowledgePath` na leitura de
bytes do repositório — não autoriza nada: ela impede um pedido declarado como
geral de apontar para a pasta de um cliente.

## 5. Quem pode administrar cada nível

| Nível | Exigências, simultâneas |
| --- | --- |
| `client` | `aiKnowledge.manage` **e** o cliente dentro do escopo de quem chama |
| `system` | `aiKnowledge.manage` **e** `assets.crossClient` **e** escopo de cliente irrestrito |

Administrador restrito a alguns clientes continua restrito a eles, e o acervo
geral não é um deles: ele entra na geração de **todo** cliente, então
administrá-lo com escopo parcial seria escrever no contexto de clientes que a
pessoa não pode nem ver.

Essa é a autorização da **pessoa**, no Norman. A autorização da **aplicação**
que fala com as rotas internas do LLM-backend é outra, e independente: cada rota
interna declara a capacidade que exige, e o consumidor só a abre se a tiver
recebido explicitamente.

| Capacidade | O que abre |
| --- | --- |
| `knowledge.client.read` | pesquisa, estado de ingestão, dossiê e visão de um cliente |
| `knowledge.client.write` | registrar, esquecer, renomear, reprocessar e reconsolidar acervo de cliente |
| `knowledge.system.read` | pesquisa, estado de ingestão e visão do acervo geral |
| `knowledge.system.write` | registrar, esquecer, renomear e reprocessar no acervo geral |
| `documents.extract` | extração de texto de um arquivo enviado |
| `connections.administer` | revisão, ativação e teste de conexão de provedor |

O consumidor `norman` recebe todas — são as portas que os adapters dele
atravessam. Qualquer outro recebe apenas o que estiver declarado, e o nível
`system` é uma capacidade separada da de cliente justamente porque escrever no
acervo geral é escrever no contexto de todos os clientes.

## 6. Revogação

- **Revogação de cliente pendente** retém o acervo daquele cliente. A camada
  geral não entra nessa decisão.
- **Revogação geral pendente ou em falha** tira **só** a camada geral das
  gerações novas. O conhecimento privado do cliente continua valendo, e a
  resposta e o registro dizem, de forma determinística, que a camada geral
  faltou (`systemKnowledgeAvailable: false`).
- **Revogação geral confirmada** remove o documento e, por cascata, os trechos
  dele: a fonte para de aparecer para todos os clientes na mesma chamada.
- A lápide sobrevive à remoção física, e a lápide geral é independente da lápide
  de cliente com o mesmo caminho.
- Não conseguir ler a caixa de saída não é prova de que ela está vazia: o lado
  seguro é a camada ficar fora.

## 6.1 As duas camadas são independentes também sob falha

Retenção não é o único jeito de uma camada faltar. A independência vale para os
quatro casos, nos dois caminhos de geração — o delegado ao executor e o legado
do Norman:

| O que aconteceu | Camada do cliente | Camada do sistema |
| --- | --- | --- |
| busca do sistema falhou | preservada, com os trechos já recuperados | indisponível e declarada |
| busca do cliente falhou | indisponível e declarada | preservada |
| revogação do cliente pendente | retida e declarada | preservada |
| revogação geral pendente | preservada | retida e declarada |
| embedding comum falhou | indisponível e declarada | indisponível e declarada |

Cada camada tem a própria consulta, o próprio filtro, o próprio orçamento de
evidência e o próprio tratamento de erro. `knowledgeUnavailable`,
`systemKnowledgeAvailable`, as evidências por camada, as citações e os avisos do
prompt descrevem a camada que realmente faltou — nunca a outra. As citações e a
auditoria trazem apenas as camadas efetivamente usadas.

A falha de uma camada nunca afrouxa o filtro da outra: o acervo de outro cliente
continua fora em todos os casos.

## 6.2 A entrada da fonte geral no acervo é uma etapa durável

O acervo de cliente é ingerido pela varredura do repositório, que resolve o dono
pela pasta. A pasta geral não é de ninguém, e por isso a fonte geral é
registrada por uma chamada explícita que carrega o nível.

Essa chamada é uma etapa com estado persistido no Norman, e não um efeito
colateral da resposta:

- a pendência é gravada **antes** da tentativa e antes de a resposta sair;
- falha, timeout ou porta de registro ausente ficam como falha visível na ficha,
  na API e na tela — nunca como sucesso;
- a identidade é o par caminho + hash, que é o que o executor já usa para
  deduplicar: repetir depois de um timeout reconcilia em vez de duplicar;
- a retomada é feita por worker, com arrendamento e espera crescente, e
  sobrevive a reinício sem reenvio do arquivo;
- há retry manual da etapa, também sem reenvio;
- a revogação cancela o anúncio que ainda não fechou, e a lápide do executor
  recusa o registro de um caminho removido: uma fonte revogada durante a corrida
  não volta ao acervo;
- enquanto o registro não fecha, a fonte não participa de geração nenhuma.

## 7. Candidato nunca é conhecimento oficial

O fluxo continua `candidato -> aprovação administrativa -> fonte oficial`.
Nesta rodada **não** existe:

- persistência automática de mensagem ou resposta como conhecimento permanente;
- promoção de candidato por decisão de um modelo;
- análise obrigatória de todo prompt.

Uma extração automática futura poderá apenas **sugerir** candidatos, de forma
assíncrona, com origem, referência da conversa, deduplicação e filtragem de
dados sensíveis. Isso fica fora desta rodada até decisão explícita do produto.

## 8. Provedores são adapters, nunca fonte da verdade

- **Grok** é o modelo/produto da **xAI**. **Groq** é outro provedor, e hoje
  atende usos específicos como transcrição. São nomes diferentes de empresas
  diferentes, e os materiais anteriores os confundem em vários pontos.
- **Ollama** é runtime/provedor local: ele executa modelos e embeddings. Ele
  **não** é orquestrador, não é barreira de isolamento e não é trava de
  segurança.
- Nenhum provedor está hardcoded no fluxo: eles entram por conexão
  provisionada, com revisão e modelo fixados na ativação.
- Nenhum modelo decide autorização, escopo ou promoção de conhecimento. Isolamento
  é filtro no banco; autorização é permissão no Norman.

## 9. Loop de busca adicional: possibilidade futura, não comportamento atual

O losango “conteúdo adequado? -> busca adicional” dos diagramas descreve um loop
iterativo de RAG que **não** existe nesta implementação. Se for adotado, precisa
nascer com limite de tentativas, orçamento de custo e latência, propagação de
cancelamento e auditoria por passagem.

## 10. Problemas editoriais dos materiais de origem

Registrados aqui, sem alterar os PDFs:

- referências `[cite: ...]` ao longo do texto sem bibliografia correspondente —
  não há como conferir a origem das afirmações citadas;
- diagrama quebrado entre páginas, com o fluxo continuando sem conector visível;
- **Grok** e **Groq** usados de forma trocada em mais de um trecho;
- a frase genérica “o usuário pode salvar” sugere que qualquer usuário final
  promove conhecimento. Upload e aprovação são administrativos;
- pastas físicas aparecem nos diagramas como se fossem o mecanismo de escopo.
  Elas são visualização operacional.

## 11. Ordem segura de publicação

Sem alteração em relação ao roteiro já registrado em
`OPERACAO_GATEWAY_E_CONHECIMENTO.md`, e agora com as migrations desta rodada:

1. manter `AI_GENERATION_PATH=legacy` no Norman;
2. publicar e migrar o **LLM-backend** (inclui `1757800000000-KnowledgeScopeLevels`);
3. publicar e migrar o **Norman** (inclui `0025_knowledge_scope_system.sql`);
4. validar health, capacidades, revisão e ativação;
5. só então ativar `gateway`;
6. rollback voltando a `legacy`, sem desfazer migrations.

O acervo geral nasce **vazio** nas duas bases: nenhuma migration classifica
linha existente como `system`. Ele só passa a existir quando alguém enviar
material pela porta administrativa dele.
