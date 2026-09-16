# Ajustes pós-auditoria — RAG, conhecimento de IA e multiprovedor

**Data:** 08/09/2026  
**Status:** plano de correção; nenhuma publicação autorizada  
**Repositórios:**

- `LLM-backend-Norman` — branch `feature/formatos-legados-doc-xls-pptx`
- `Norman` — branch `feature/finalizacao-camada-conhecimento`

## 1. Objetivo

Concluir a implementação descrita no relatório de 08/09/2026 sem ativar o novo caminho de geração antes de provar:

1. isolamento real entre clientes;
2. recuperação de todo o conhecimento oficial do cliente;
3. exclusão de anexos não aprovados;
4. revogação fail-closed, inclusive durante falhas entre serviços;
5. preservação dos prompts e contratos atuais do produto;
6. troca administrativa de provedor executada e testada no LLM-backend;
7. ciclo de vida uniforme para documento, texto e áudio;
8. processamento recuperável depois de reinício;
9. auditoria e citações utilizáveis pelo Norman;
10. configuração e operação que não dependam de segredos duplicados.

O novo gateway não está pronto para ser ligado em dev enquanto os bloqueadores deste documento não estiverem implementados e validados.

## 2. Limites obrigatórios

- Não fazer push.
- Não publicar em dev, homologação ou produção.
- Não executar migration em banco remoto.
- Não alterar ou reprocessar dados remotos.
- Não executar backfill.
- Trabalhar somente nas duas branches listadas acima.
- Preservar todos os arquivos não rastreados já existentes.
- Fazer commits locais pequenos, coerentes e reversíveis.
- Usar a identidade Git já configurada em cada repositório, sempre com `admin@ptwag.com`.
- Não incluir referência a Claude, Codex, ChatGPT ou qualquer assistente em código, documentação, mensagens ou autoria dos commits.
- Nunca colocar chave, token, senha, URL com credencial ou segredo em código, teste, fixture, log, relatório ou commit.
- A chave do Grok anteriormente compartilhada deve ser considerada exposta. Não usá-la. O aceite real deverá utilizar uma chave substituta, provisionada depois no ambiente seguro do LLM-backend.

## 3. Estado confirmado antes das correções

- LLM-backend: 493 testes passam e 16 estão ignorados.
- Norman: 10.629 testes passam e 4 estão ignorados.
- Os commits da implementação anterior são locais.
- O caminho legado deve continuar sendo o padrão e o rollback até o aceite integral.

Esses números são a linha de base, não o aceite final.

## 4. Arquitetura de destino

```text
Administrador do Norman
        |
        | escolhe uma conexão já provisionada e testada
        v
Plano de controle no Norman
        |
        | connection key + revisão imutável + feature + clientId + escopo
        v
Gateway interno no LLM-backend
        |
        +--> valida consumidor, operação, escopo e revisão
        +--> monta contexto oficial do cliente
        +--> consulta dossiê, tokens de marca e chunks vigentes
        +--> chama Ollama, Grok, OpenAI ou conexão futura provisionada
        +--> devolve texto/eventos, evidências, citações e auditoria
```

O navegador nunca envia segredo, URL arbitrária, prompt de sistema ou nome de modelo não permitido. O Norman não deve possuir as credenciais dos provedores. A URL base, a chave, os modelos permitidos e as capacidades pertencem ao executor no LLM-backend.

## 5. Bloqueadores obrigatórios

### P0.1 — Recuperação do cliente inteiro e exclusões oficiais

#### Defeito atual

Quando a conversa tem `clientId`, mas não tem pasta específica, o Norman delega `scopePath: null`. O LLM-backend só pesquisa chunks quando `scopePath` é preenchido. Assim, o gateway lê o dossiê, porém não consulta o acervo completo.

Além disso, o caminho legado exclui `02_Briefings` das buscas gerais, mas `excludeScopePaths` não existe no contrato do Norman com o gateway.

#### Implementação

1. Ao resolver um cliente autorizado, determinar também seu caminho raiz canônico a partir de `assetFolderName || name`.
2. Para conhecimento geral do cliente, enviar:
   - `clientId`;
   - caminho raiz do cliente;
   - `includeDescendants: true`;
   - exclusão de `<raiz>/02_Briefings`.
3. Para uma pasta explicitamente autorizada de um projeto, preservar o comportamento específico sem aplicar uma exclusão que elimine a própria pasta consultada.
4. Adicionar `excludeScopePaths` aos tipos de contexto, pedido do gateway, cliente HTTP e adapter do Norman.
5. No LLM-backend, continuar filtrando sempre por `clientId` e validar limites e formato de todos os caminhos.
6. Não aceitar que apenas um caminho fornecido pelo navegador determine o cliente proprietário.

#### Testes de aceite

- Cliente com apenas `clientId` recupera chunk existente sob sua raiz.
- O mesmo pedido não recupera chunk de outro cliente.
- Busca geral não recupera conteúdo de `02_Briefings`.
- Busca específica e autorizada de um projeto continua alcançando seu anexo.
- Caminho pertencente a outro cliente é recusado, não convertido em busca parcial.
- Acervo vazio e acervo indisponível continuam sendo estados diferentes.

### P0.2 — Revogação fail-closed e consistente entre serviços

#### Defeito atual

O Norman pode marcar uma fonte como revogada mesmo quando a invalidação no LLM-backend falha. Nesse intervalo, os chunks antigos continuam pesquisáveis. A revogação de um candidato também ignora um retorno `revocationState: "failed"` e pode finalizar como revogada.

#### Implementação

1. Criar no LLM-backend uma operação idempotente que grave uma lápide durável antes de remover derivados fisicamente.
2. Todas as consultas de chunks e notas devem ignorar fontes/documentos com lápide vigente.
3. A invalidação física pode ser posterior, mas a exclusão lógica precisa ocorrer na mesma transação que confirma a revogação no executor.
4. Manter no Norman uma caixa de saída persistente para tentativas pendentes e falhas de invalidação.
5. Enquanto houver revogação `pending` ou `failed` para um cliente, o Norman deve impedir geração com o conhecimento desse cliente ou responder explicitamente que o acervo está indisponível. Nunca degradar silenciosamente para dados possivelmente revogados.
6. O candidato só muda de `approved` para `revoked` quando a fonte oficial retornar confirmação de revogação.
7. Tratar explicitamente retornos `pending`, `failed` e `confirmed`; não depender apenas de exceções.
8. Preservar CAS/versão de processamento para que jobs antigos não republiquem a fonte.
9. Criar retry idempotente e observável para falhas entre Norman e LLM-backend.

#### Testes de aceite

- Falha de rede durante revogação não permite que o conteúdo continue sendo usado numa geração iniciada pelo Norman.
- Retorno `{ revocationState: "failed" }` mantém o candidato aprovado e visivelmente pendente de correção.
- Repetir a mesma revogação não duplica trabalho nem muda o resultado.
- Job iniciado antes da revogação não consegue publicar depois dela.
- A busca direta do LLM-backend ignora uma fonte com lápide.
- O retry posterior confirma a remoção sem recriar a fonte.

### P0.3 — Tokens estruturados de marca no gateway

#### Defeito atual

O caminho legado acrescenta `brand_tokens` ao contexto. Quando o adapter declara `buildsOwnContext`, esse bloco deixa de ser montado pelo Norman, e o gateway usa apenas dossiê e chunks.

#### Implementação

1. Definir uma única autoridade para tokens aprovados de marca.
2. Fazer o gateway receber ou consultar os tokens estruturados vigentes com revisão, procedência e `clientId`.
3. Não converter os tokens em texto livre antes da validação do contrato.
4. Montar no LLM-backend um bloco privilegiado e determinístico com cores, fontes, tom, restrições e demais tipos suportados.
5. Token aprovado mais recente deve vencer informação conflitante do dossiê, e essa precedência deve ser explícita e testada.
6. Token de um cliente nunca pode compor o contexto de outro.

#### Testes de aceite

- Cor e tipografia aprovadas aparecem no prompt final do gateway.
- Alteração de token muda somente a revisão seguinte.
- Conflito entre dossiê e token usa o token vigente.
- Cliente B nunca recebe tokens do cliente A.
- Remoção/revogação de token deixa de influenciar a próxima geração.

### P0.4 — Paridade dos prompts de produção

#### Defeito atual

Os prompts do gateway são resumos genéricos e não preservam todos os contratos do caminho legado, como campos exatos, condução do briefing, marcadores e regras de literalidade.

#### Implementação

1. Inventariar todos os prompts e transformações do caminho legado para:
   - chat;
   - chat com streaming;
   - briefing final;
   - briefing de documento;
   - briefing de workflow;
   - briefing de workflow com streaming;
   - insights.
2. Portar o comportamento para o registro de features do LLM-backend sem aceitar prompt privilegiado vindo do Norman.
3. Preservar contratos JSON, campos obrigatórios, marcadores e tratamento de histórico.
4. Criar testes dourados comparando as mensagens finais do legado e do gateway para entradas equivalentes.
5. Incluir a regressão Selenita: `ORQUIDEA CROMADA 47`, `azul-cobalto` e `knowledge-layer-test.pdf`.
6. Não ativar o gateway enquanto as diferenças comportamentais não estiverem explicitamente aprovadas.

#### Testes de aceite

- Os seis campos do briefing continuam presentes e corretamente interpretados.
- `BRIEFING_READY` e transições de conversa preservam o comportamento atual.
- Identificadores literais não são trocados por nomes de entidade.
- Saída inválida do provedor produz erro controlado, sem JSON parcialmente aceito.
- Fixtures representativas produzem envelopes equivalentes nos dois caminhos.

### P0.5 — Streaming real e cancelamento

#### Defeito atual

As operações chamadas de streaming aguardam a resposta completa e enviam tudo num único evento.

#### Implementação

1. Adicionar streaming no adapter de protocolo compatível com OpenAI.
2. Criar rota interna de streaming com eventos normalizados e versão de contrato.
3. Propagar cancelamento do navegador até Norman, gateway e provedor.
4. Emitir metadados finais de uso, provedor, modelo, evidências e citações sem misturá-los ao texto.
5. Tratar conexão interrompida, timeout e fallback antes do primeiro token.
6. Depois do primeiro token, não trocar silenciosamente de provedor e concatenar duas respostas.

#### Testes de aceite

- Mais de um delta é observado antes da conclusão.
- Cancelar encerra a chamada ao provedor.
- Erro antes do primeiro token respeita a política de fallback.
- Erro depois do primeiro token termina a resposta com estado explícito.
- O texto acumulado é igual ao conteúdo recebido em ordem.

### P0.6 — Seleção e teste de provedores no executor correto

#### Defeito atual

O LLM-backend conhece Ollama, OpenAI e Grok, mas o Norman cadastra somente Ollama e Grok. O teste administrativo abre conexão diretamente do Norman, duplicando segredos e testando um caminho diferente do que executará a geração.

#### Implementação

1. Cadastrar conexão OpenAI no plano de controle do Norman, inicialmente indisponível enquanto não estiver provisionada.
2. Preservar Grok como indisponível até existirem chave substituta, modelo e allowlist válidos no LLM-backend.
3. Remover do Norman a necessidade de `OPENAI_API_KEY`, `GROK_API_KEY` e equivalentes.
4. Criar endpoint interno no LLM-backend para testar uma conexão provisionada usando o mesmo resolver, adapter, rede e política da geração real.
5. O Norman envia somente a chave lógica e a revisão da conexão.
6. A tela administrativa mostra `configuração pendente`, `teste falhou`, `teste passou` e `ativa` como estados diferentes.
7. Só permitir ativação de revisão habilitada, configurada, permitida e testada com sucesso.
8. Manter CAS na ativação para duas telas administrativas concorrentes.
9. Para provedores futuros, usar cadastro/registro server-side com URL base e segredos referenciados por variável ou secret manager. Nunca aceitar URL arbitrária diretamente do frontend.

#### Testes de aceite

- OpenAI aparece na administração, mas não pode ser ativada sem configuração e teste.
- Grok aparece sem expor motivo sensível ou segredo.
- Teste verde comprova a chamada feita pelo LLM-backend.
- Alterar variável apenas no Norman não torna a conexão disponível.
- Chave de Grok nunca aparece em snapshot, log, resposta, teste ou banco.
- Seleção feita por um administrador passa a valer para os demais usuários.
- Usuário não administrador não vê nem chama teste/ativação.

### P0.7 — Cliente obrigatório e autorização explícita

1. Classificar cada feature como genérica ou vinculada a cliente.
2. Nas features vinculadas, configurar `requiresClient: true` e recusar ausência de cliente.
3. Corrigir entradas diretas, inclusive `/api/ai/briefing`, para resolver o escopo autorizado antes da geração.
4. Documentar a fronteira de confiança: o Norman autoriza o usuário; o token interno identifica o Norman; o LLM-backend valida consumidor, feature e formato do escopo.
5. Se o LLM-backend precisar validar associação usuário-cliente independentemente, implementar claim assinado ou introspecção. Não fingir que o `actor` enviado no corpo já prova autorização.

#### Testes de aceite

- Feature de cliente sem `clientId` é recusada.
- Usuário sem acesso ao cliente não produz chamada ao gateway.
- Cliente A e cliente B geram auditorias e contextos completamente separados.
- Consumidor sem permissão para a feature recebe recusa.

## 6. Ciclo de vida unificado do conhecimento

### P1.1 — Documento, texto e áudio na mesma fonte administrativa

1. Ao indexar documento oficial do repositório, criar ou atualizar `knowledge_sources` com `kind: "document"`.
2. Vincular a fonte ao documento, storage path, hash, versão e notas geradas.
3. Mostrar documentos na mesma lista administrativa de texto e áudio.
4. Implementar substituição, nova versão, desativação, revogação e reprocessamento sem apagar silenciosamente a procedência.
5. Remoção observada no repositório deve produzir a mesma lápide durável usada pelas outras fontes.
6. Não transformar automaticamente `02_Briefings` em conhecimento oficial.
7. Preservar suporte e regressões de `.pdf`, `.docx`, `.doc`, `.xlsx`, `.xlsm`, `.xls`, `.pptx` e formatos de texto já aceitos.

### P1.2 — Áudio recuperável depois de reinício

1. Persistir o arquivo de áudio em storage temporário antes de responder sucesso.
2. Enfileirar somente identificadores duráveis, nunca o `Buffer` como única cópia.
3. Usar fila persistente e worker idempotente.
4. Ao reiniciar, tarefas `received` ou `transcribing` devem ser retomadas automaticamente.
5. Reenvio pelo mesmo hash deve retomar a fonte quando apropriado sem duplicar transcrição.
6. Limpar áudio temporário apenas depois do estado terminal e segundo política de retenção.
7. Exibir claramente `recebido`, `transcrevendo`, `estudando`, `pronto`, `falhou`, `revogação pendente` e `revogado`.

## 7. Citações, evidências e interface administrativa

1. Não descartar `citations` e `evidence` no adapter do Norman.
2. Propagar metadados até a resposta adequada da API e até a interface, sem misturá-los ao texto do modelo.
3. Permitir ao administrador abrir a fonte correta e, quando houver, a página correta.
4. Guardar na auditoria apenas identificadores, página, similaridade, revisão e procedência necessárias; não copiar conteúdo sensível de chunks para logs.
5. A aba **Conhecimento de IA** deve apresentar:
   - Conhecimentos gerais do cliente;
   - Aprendizados por cliente;
   - fontes, versões e estados;
   - conteúdo das notas e tokens estruturados;
   - candidatos, decisão e autor;
   - falhas de ingestão, transcrição, estudo e revogação;
   - evidências/citações das operações quando aplicável.
6. Continuar restrita a administradores até nova decisão de produto.

## 8. Configuração, deploy e retenção

Mesmo sem executar deploy, deixar o código e a documentação preparados:

1. Atualizar `.env.example` dos dois repositórios com todas as variáveis realmente usadas.
2. No Norman, documentar somente gateway, seleção e token interno; remover orientação de credenciais diretas de provedores quando o caminho novo estiver em uso.
3. No LLM-backend, documentar URLs, chaves, modelos, allowlists, timeout, consumidores internos e retenção.
4. Atualizar a validação do deploy para falhar antes do restart quando a conexão ativa não puder ser resolvida.
5. A saúde deve distinguir:
   - processo saudável;
   - gateway saudável;
   - conexão ativa configurada;
   - provedor alcançável;
   - fila e banco saudáveis;
   - decisões de retenção pendentes.
6. Variáveis de retenção sem rotina de limpeza não contam como retenção implementada. Criar jobs idempotentes, métricas e testes para os prazos aprovados.
7. Não inventar prazos. Se a decisão não existir, manter a limpeza desabilitada, sinalizar pendência na saúde e documentar o comando/ação necessária.
8. Preparar autenticação do Redis e separação de ambientes sem alterar infraestrutura remota nesta tarefa.

## 9. Fallback, auditoria e provedores futuros

1. Fallback continua desligado por padrão.
2. A política deve declarar causas permitidas, conexão de destino e máximo de tentativas.
3. Não executar fallback por erro de validação, autorização, prompt, escopo ou revogação.
4. Cada tentativa registra correlação, feature, cliente, revisão, provedor, modelo, duração, uso e motivo normalizado.
5. O modelo efetivamente usado deve vir da resposta do executor, não de uma suposição do Norman.
6. O contrato de consumidores futuros, incluindo Niprofe, deve usar token próprio, allowlist de features e escopos mínimos.
7. Sem acesso ao sistema externo, implementar e testar apenas o contrato interno; registrar a integração real como bloqueio externo, sem afirmar que foi validada.

## 10. Ordem recomendada

1. P0.1: escopo raiz e exclusões.
2. P0.2: revogação fail-closed e retry persistente.
3. P0.3: tokens estruturados.
4. P0.7: cliente obrigatório e fronteira de autorização.
5. P0.4: paridade de prompts.
6. P0.6: teste e seleção dos provedores no LLM-backend.
7. P0.5: streaming real.
8. P1.1: fontes documentais unificadas.
9. P1.2: fila persistente de áudio.
10. Citações, retenção, saúde e documentação operacional.

Não mascarar um bloqueador implementando apenas a interface. Cada etapa deve fechar contrato, persistência, comportamento, erro e teste.

## 11. Validação local obrigatória

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

Também executar:

- `git diff --check` nos dois repositórios;
- testes reais de PostgreSQL + pgvector disponíveis localmente;
- testes de contrato Norman ↔ LLM-backend com os dois processos locais;
- teste A/B de isolamento com dois clientes;
- teste de revogação durante falha simulada de rede;
- teste de reinício durante transcrição;
- teste de streaming e cancelamento;
- teste de paridade legado/gateway;
- busca por segredos e referências indevidas antes de cada commit.

Testes ignorados precisam ser listados pelo nome e motivo. Não contar teste ignorado como aceite.

## 12. Critérios para considerar a implementação concluída

A tarefa local termina somente quando:

- todos os P0 e P1 deste documento estiverem implementados ou houver bloqueio externo objetivo documentado;
- nenhuma geração vinculada a cliente puder acontecer sem escopo autorizado;
- conhecimento geral consultar chunks e excluir fontes não aprovadas;
- revogação falhar fechada;
- tokens estruturados chegarem ao prompt final;
- prompts do gateway preservarem o contrato estável;
- streaming for realmente incremental;
- teste de conexão passar pelo executor real;
- documentos, textos e áudios tiverem ciclo de vida administrável;
- áudio sobreviver a reinício;
- citações forem preservadas até a interface/auditoria;
- as suítes e gates locais estiverem verdes;
- nenhum segredo estiver no histórico Git;
- os commits forem apenas locais.

## 13. Entrega esperada

Ao terminar, produzir um relatório novo contendo:

1. tabela requisito → arquivos → testes → evidência;
2. commits locais por repositório;
3. comandos executados e resultados;
4. testes ignorados e razão;
5. diferenças deliberadas em relação ao legado;
6. migrations locais criadas, sem executá-las remotamente;
7. riscos e decisões ainda externas;
8. roteiro separado de publicação e aceite em dev;
9. confirmação explícita de que não houve push, deploy, backfill ou uso de segredo real.

Não usar “concluído”, “pronto para produção” ou equivalente se qualquer bloqueador de segurança, isolamento, revogação ou paridade continuar aberto.
