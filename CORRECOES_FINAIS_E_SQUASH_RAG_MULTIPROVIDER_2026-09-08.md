# Correções finais e squash — RAG e gateway multiprovedor

**Data:** 08/09/2026  
**Status:** especificação de correção local; não autoriza publicação  
**Documento anterior:** `AJUSTES_POS_AUDITORIA_RAG_MULTIPROVIDER_2026-09-08.md`

## 1. Objetivo

Corrigir as lacunas encontradas depois da implementação pós-auditoria e consolidar os commits locais em um único commit por repositório.

As suítes atuais estão verdes, mas isso ainda não representa aceite porque há comportamentos incorretos que os testes existentes aprovam ou não exercitam.

## 2. Repositórios, branches e bases do squash

### LLM-backend

- Diretório: `/Users/diego.alipio/ptw/LLM-backend-Norman`
- Branch: `feature/formatos-legados-doc-xls-pptx`
- Commit-base que deve permanecer intacto: `aded5b9`
- Tudo depois de `aded5b9`, incluindo as novas correções, deve terminar em um único commit local.

### Norman

- Diretório: `/Users/diego.alipio/ptw/Norman`
- Branch: `feature/finalizacao-camada-conhecimento`
- Commit-base que deve permanecer intacto: `2af225a`
- Tudo depois de `2af225a`, incluindo as novas correções, deve terminar em um único commit local.

## 3. Limites obrigatórios

- Não fazer push.
- Não fazer deploy.
- Não executar migration ou backfill remotamente.
- Não usar nem testar a chave do Grok compartilhada anteriormente; ela está exposta e precisa ser substituída.
- Não colocar segredos em arquivos, comandos registrados, fixtures, logs, relatórios ou commits.
- Preservar todos os arquivos não rastreados existentes.
- Não incluir os documentos de plano não rastreados no squash.
- Não criar outra branch de trabalho.
- Usar a identidade Git já configurada em cada repositório, com `admin@ptwag.com`.
- Não adicionar `Co-authored-by` nem referência a assistente.
- Não adicionar novos comentários ao código.
- O caminho legado continua como padrão até o aceite em dev.

## 4. Correções obrigatórias

### P0.1 — Provedores externos não podem exigir segredo duplicado no Norman

#### Problema

O teste da conexão já acontece no LLM-backend, mas a ativação e a seleção de modelo no Norman continuam usando `resolveConnection(connection, env)`. Assim, Grok e OpenAI somente podem ser ativados se chave, URL, modelo e allowlist também existirem no ambiente do Norman.

Isso contradiz a fronteira definida: credenciais e configuração executável devem pertencer ao LLM-backend.

#### Correção

1. Remover da ativação, seleção de modelo, fallback e visão administrativa do gateway qualquer dependência das chaves de provedor existentes no ambiente do Norman.
2. Obter do LLM-backend, por rota interna autenticada, somente os metadados públicos necessários:
   - conexão disponível ou indisponível;
   - revisão reconhecida;
   - modelo padrão;
   - modelos permitidos;
   - capacidades;
   - resultado do teste.
3. O Norman deve persistir apenas o plano de controle: chave lógica, revisão, modelo selecionado, ativação, política e auditoria.
4. Segredos, URL base e resolução do adapter ficam somente no LLM-backend.
5. O rollback legado deve ser uma configuração explícita e independente, preferencialmente o Ollama local. Ele não justifica duplicar chaves de Grok ou OpenAI no Norman.
6. Atualizar `.env.example`, documentação, prontidão e interface para refletir a fronteira real.
7. Se o caminho legado ainda exigir uma variável própria, nomeá-la e isolá-la como legado, sem reutilizar o cadastro do gateway.

#### Aceite

- Grok provisionado somente no LLM-backend pode ser testado e ativado pelo administrador.
- Remover `GROK_API_KEY` e `OPENAI_API_KEY` do Norman não impede teste, seleção nem ativação pelo gateway.
- A chave nunca atravessa a resposta de capacidades.
- O rollback para o legado continua possível usando sua configuração própria.

### P0.2 — Revisão e ativação precisam ser reais, não apenas campos de auditoria

#### Problema

O LLM-backend recebe `activationId` e `connectionRevision`, mas executa somente por `connectionKey` e modelo permitido. Uma revisão inexistente, antiga ou incompatível ainda é aceita.

#### Correção

1. Criar no LLM-backend um registro persistente de revisões de conexão reconhecidas pelo executor.
2. Uma revisão deve vincular, de forma imutável:
   - chave da conexão;
   - número da revisão;
   - modelo selecionado;
   - identificador ou digest da configuração provisionada;
   - estado habilitado/desabilitado;
   - data de criação.
3. Sincronizar uma revisão por rota interna administrativa e idempotente, sem transmitir URL ou segredo.
4. A sincronização deve validar o modelo contra a allowlist do executor.
5. Teste e geração devem resolver exatamente `connectionKey + connectionRevision`.
6. Rejeitar revisão inexistente, desabilitada, de outra conexão ou com modelo divergente.
7. Vincular a ativação a uma revisão reconhecida. Não aceitar `activationId` arbitrário como se provasse uma ativação.
8. Se for adotada assinatura de snapshot em vez de replicação, usar assinatura autenticada e expiração, com testes de adulteração e replay. Não deixar o campo sem validação.

#### Aceite

- Revisão 2 não executa usando silenciosamente a configuração da revisão 1.
- Alterar apenas o número da revisão no corpo produz recusa antes do provedor.
- Modelo diferente do registrado produz recusa.
- O registro de execução aponta para a revisão realmente resolvida.
- Teste administrativo aprova exatamente a revisão depois ativada.

### P0.3 — Persistência do áudio deve acontecer antes do sucesso

#### Problema

`storeAudio` captura falha do storage, devolve a fonte sem caminho e o upload ainda responde sucesso. Se o processo reiniciar, o áudio desaparece.

#### Correção

1. Falha ao persistir o áudio deve impedir o agendamento e impedir resposta de aceite.
2. Retornar erro controlado e reprocessável, sem afirmar que a fonte foi aceita.
3. Manter estado coerente no banco:
   - remover a linha incompleta de forma transacional; ou
   - mantê-la como `failed`, com motivo seguro e sem trabalho agendado.
4. Somente responder `202` quando banco e storage confirmarem a cópia durável.
5. Se o agendamento imediato falhar depois da persistência, deixar a fonte em `received` para o worker retomá-la.
6. Não apagar áudio em falha enquanto ainda houver possibilidade de retry.

#### Aceite

- Storage indisponível não retorna sucesso.
- Nenhuma transcrição começa usando apenas o `Buffer` quando a persistência falhou.
- Reinício imediatamente depois de `202` retoma o áudio sem reenvio.
- Erro ao agendar mantém o áudio recuperável pelo worker.

### P0.4 — Claim, lease e recuperação de áudio sem transcrição duplicada

#### Problema

O worker lista qualquer fonte em `received` ou `transcribing` a cada minuto. Uma transcrição ainda ativa pode ser reclamada, avançar a versão e começar novamente. Em chamadas longas isso pode se repetir a cada ciclo.

#### Correção

1. Transformar a recuperação em fila persistente real ou implementar lease durável equivalente.
2. Adicionar claim atômico com, no mínimo:
   - `claimed_by`;
   - `claimed_at`;
   - `lease_until`;
   - número de tentativas;
   - próximo horário de tentativa.
3. Fonte `transcribing` só pode ser retomada se o lease expirou.
4. Renovar o lease enquanto a transcrição estiver ativa ou usar prazo superior ao timeout máximo comprovado.
5. Duas réplicas não podem transcrever a mesma fonte simultaneamente.
6. Aplicar backoff às falhas e impedir loop a cada minuto.
7. O trabalho deve carregar somente o identificador da fonte; os bytes vêm do storage durável.

#### Aceite

- Duas chamadas concorrentes do worker produzem uma única chamada de transcrição.
- Worker rodando novamente antes do vencimento do lease não reclama a fonte.
- Depois de simular crash e expirar o lease, outra instância retoma.
- Transcrição acima de 60 segundos não é reiniciada.
- Retry respeita backoff e limite configurado.

### P0.5 — Cancelamento deve observar a conexão de resposta

#### Problema

O Norman observa `close` no request. Em Node esse evento ocorre quando a requisição foi concluída, não representa de forma confiável o fechamento da resposta pelo navegador. O teste atual dispara o evento artificialmente e não comprova uma conexão HTTP real.

#### Correção

1. Observar `res.on("close")` ou o socket de resposta para detectar que o consumidor foi embora.
2. Manter `req.on("aborted")` apenas para corpo de requisição abortado.
3. Não usar `req.on("close")` como sinal principal de abandono da resposta.
4. Propagar o mesmo `AbortSignal` por Norman → cliente HTTP → gateway → adapter → `fetch` do provedor.
5. Remover listeners ao terminar normalmente para não acumular referências.
6. Diferenciar cancelamento do usuário de timeout e erro do provedor.

#### Aceite

- Teste com servidor HTTP real abre streaming, recebe um delta e fecha a conexão.
- O `fetch` do provedor observa `signal.aborted === true`.
- Uma requisição normal não é cancelada apenas porque o corpo terminou.
- Conclusão normal não é registrada como cancelamento.

### P0.6 — Operações por cliente não podem degradar silenciosamente para modo genérico

#### Problema

Todas as features ficaram com `clientBinding: "optional"`. Se uma tela por cliente deixar de enviar `clientId`, o gateway responde sem conhecimento e não acusa o defeito de transporte.

#### Correção

1. Separar semanticamente operações genéricas das operações vinculadas a cliente.
2. Criar feature ou rota genérica explícita para a conversa anterior à escolha do cliente.
3. Marcar como `required` todas as operações executadas depois que o fluxo foi vinculado a cliente.
4. Em pedidos que declaram `clientId`, falha de autorização ou de resolução do escopo deve retornar erro, nunca continuar sem contexto.
5. A interface deve trocar explicitamente do modo genérico para o modo por cliente.
6. Depois da escolha, toda chamada subsequente deve carregar o mesmo cliente autorizado.
7. Auditoria deve distinguir modo genérico e modo por cliente.

#### Aceite

- Fluxo genérico antes da escolha continua funcionando sem acervo.
- Fluxo por cliente sem `clientId` falha visivelmente.
- `clientId` não autorizado retorna `403`, não uma resposta genérica.
- Teste de regressão remove o `clientId` da chamada por cliente e prova que o provedor não é chamado.

### P0.7 — Upload de documentos dentro de Conhecimento de IA

#### Problema

A aba administrativa permite áudio e texto, mas documentos precisam ser enviados por outra tela. Não há upload nem substituição de arquivo no local em que o administrador gerencia o conhecimento.

#### Correção

1. Adicionar, em **Conhecimentos gerais do cliente**, um controle de upload de documentos.
2. Aceitar os formatos já suportados:
   - `.pdf`;
   - `.doc` e `.docx`;
   - `.xls`, `.xlsx` e `.xlsm`;
   - `.pptx`;
   - formatos de texto permitidos pelo extrator.
3. Validar por extensão e conteúdo/MIME conforme as regras do backend, inclusive `application/octet-stream` quando a extensão é confiável.
4. Armazenar na pasta canônica `Conhecimentos gerais do cliente` do cliente selecionado.
5. Exibir progresso, falha de upload, extração, estudo, notas e quantidade de chunks.
6. Implementar substituição/nova versão sem apagar a procedência anterior.
7. Permitir múltiplos arquivos com limite explícito de quantidade e tamanho.
8. Não aceitar áudio nessa rota documental; áudio continua no fluxo próprio de transcrição.

#### Aceite

- Um administrador consegue enviar PDF, DOC, XLS e PPTX sem sair da aba.
- Usuário sem permissão não vê o controle nem consegue chamar a rota.
- O documento aparece na lista de fontes e em aprendizados.
- Nova versão preserva a anterior fora de vigência.
- Upload de outro cliente não é possível alterando o corpo da requisição.

### P0.8 — Excel deve atravessar todas as entradas do Norman

#### Problema

`/api/ai/extract-document` aceita Word e PowerPoint, mas não contém MIME types de Excel e anuncia uma lista de formatos incompatível com o extrator real.

#### Correção

1. Centralizar a decisão de formato suportado para evitar listas diferentes em cada rota.
2. Incluir `.xls`, `.xlsx` e `.xlsm` e seus MIME types.
3. Preservar decisão por extensão antes do MIME quando o repositório devolver `application/octet-stream`.
4. Remover formatos anunciados que o backend não suporta ou implementar o suporte correspondente.
5. Usar mensagens de erro que listem os formatos reais.

#### Aceite

- Arquivos reais `.xls`, `.xlsx` e `.xlsm` atravessam o Norman e chegam ao extrator.
- `application/octet-stream` com extensão permitida funciona.
- Arquivo incompatível continua recusado antes de processamento caro.

### P1.1 — Remover byte NUL do arquivo TypeScript

#### Problema

`server/modules/ai-knowledge/brand-tokens.ts` contém um byte NUL literal na chave de deduplicação. O TypeScript compila, mas ferramentas e Git tratam o arquivo como binário.

#### Correção

1. Trocar o caractere literal por separador textual seguro ou escape representado no fonte.
2. Garantir arquivo UTF-8 textual, sem byte NUL.
3. Confirmar que `git diff` volta a mostrar mudanças de linha normalmente.
4. Preservar o comportamento de deduplicação com teste.

#### Aceite

- `file server/modules/ai-knowledge/brand-tokens.ts` identifica texto UTF-8/ASCII.
- Contagem de bytes NUL é zero.
- Suíte de tokens continua verde.

### P1.2 — Raiz do cliente precisa cobrir as grafias realmente armazenadas

#### Problema

O sistema reconhece que Drive e Supabase podem usar raízes cruas e sanitizadas, mas a busca do cliente inteiro envia somente uma raiz produzida por `clientKnowledgeRoot`. Cliente com espaços, `&`, acentos ou underscores pode ter chunks sob outro alias e receber acervo vazio.

#### Correção

1. Não basear a busca geral em uma única grafia presumida.
2. Preferir busca por `clientId` como trava principal e aplicar exclusões por segmentos/pastas oficiais.
3. Se caminhos continuarem obrigatórios, enviar uma lista validada de raízes canônicas pertencentes ao mesmo cliente.
4. Resolver colisões de aliases de forma fail-closed.
5. Não re-sanitizar caminho já persistido.

#### Aceite

- Cliente `Jonson & Co` recupera chunks armazenados tanto sob `Jonson & Co` quanto sob `Jonson___Co`.
- `Jonson_Co` de outro cliente não entra por aproximação.
- O cliente de teste com espaços no nome consulta todo o acervo.
- `02_Briefings` continua excluída em todas as grafias da raiz.

### P1.3 — Estado dos documentos precisa acompanhar qualquer caminho oficial

#### Problema

`listSources` verifica estudo apenas dentro de `<cliente>/Conhecimentos gerais do cliente`, mas `registerDocumentSource` registra documentos oficiais de outros caminhos. Esses documentos podem permanecer eternamente em `studying` na interface.

#### Correção

1. Consultar o estado pelo `assetPath` de cada fonte ou por toda a raiz autorizada do cliente.
2. Não inferir prontidão apenas pela pasta nova.
3. Atualizar para `ready` somente quando o documento correspondente e suas notas estiverem realmente prontos.
4. Propagar falha de ingestão/estudo para a ficha administrativa.

#### Aceite

- Documento em `01_Brand_Guide_Institucional` chega a `ready`.
- Documento em `Conhecimentos gerais do cliente` também chega a `ready`.
- Documento que falhou mostra `failed` com motivo seguro.
- Um arquivo pronto não altera por engano o estado de outro com nome semelhante.

## 5. Validações obrigatórias antes do squash

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
- teste de contrato das duas pontas com revisão inválida;
- teste de ativação sem chave de Grok/OpenAI no Norman;
- teste HTTP real de cancelamento;
- concorrência real do claim de áudio;
- falha do storage antes do `202`;
- upload real das extensões legadas pela rota do Norman;
- raiz crua e raiz sanitizada para o mesmo cliente;
- prontidão de documento fora da pasta nova;
- busca por segredos reais;
- confirmação de que nenhum teste foi convertido em `skip`.

## 6. Squash obrigatório

Fazer o squash somente depois de todas as correções e validações estarem verdes.

### Segurança antes de reescrever

1. Confirmar que as branches continuam corretas.
2. Registrar no relatório os hashes anteriores ao squash.
3. Confirmar que os commits-base existem e são ancestrais de `HEAD`.
4. Confirmar que não há arquivo rastreado modificado fora da entrega.
5. Não adicionar os arquivos de plano que estão não rastreados.
6. É permitido criar uma tag local de segurança antes do squash. Não publicar a tag.

### Resultado exigido no LLM-backend

- Preservar `aded5b9` e todo o histórico anterior.
- Consolidar tudo em `aded5b9..HEAD` em um único commit.
- Mensagem sugerida:

```text
feat: conclui ajustes de RAG e gateway multiprovedor
```

### Resultado exigido no Norman

- Preservar `2af225a` e todo o histórico anterior.
- Consolidar tudo em `2af225a..HEAD` em um único commit.
- Mensagem sugerida:

```text
feat: conclui conhecimento de IA e integração multiprovedor
```

### Verificação depois do squash

Em cada repositório:

```bash
git log --oneline <commit-base>..HEAD
git diff --check <commit-base>..HEAD
git status --short
```

O primeiro comando deve mostrar exatamente um commit. Depois do squash, repetir pelo menos typecheck, build e a suíte completa dos dois repositórios. No Norman, repetir também o gate de cobertura.

Não usar `git push`, `git push --force`, rebase remoto ou qualquer comando de publicação.

## 7. Atualização do relatório

Atualizar `RELATORIO_AJUSTES_POS_AUDITORIA_2026-09-08.md` para:

- remover afirmações que os defeitos acima contradizem;
- registrar os testes novos;
- registrar os dois hashes anteriores ao squash;
- mostrar apenas um commit final por repositório;
- corrigir a contagem total de commits;
- manter os bloqueios externos reais;
- declarar que Grok não foi testado com chave real;
- declarar que não houve push, deploy, migration remota ou backfill.

## 8. Condição de término

Não considerar a tarefa pronta se:

- Grok/OpenAI ainda precisarem de segredo duplicado no Norman;
- a revisão continuar sendo apenas um número aceito do corpo;
- upload de áudio puder responder sucesso sem persistência;
- duas réplicas puderem transcrever a mesma fonte;
- o navegador não conseguir cancelar a geração;
- fluxo por cliente puder perder `clientId` silenciosamente;
- documento não puder ser enviado pela aba administrativa;
- Excel continuar bloqueado em alguma entrada relevante;
- existir byte NUL em fonte TypeScript;
- uma das grafias legítimas da raiz não for pesquisada;
- documento oficial puder ficar preso em `studying`;
- houver mais de um commit depois de cada commit-base.
