# Conclusão da camada de conhecimento e gateway multiprovedor

Data: 08/09/2026.
Estado: plano para implementação local; não é autorização de publicação.
Destinatário: agente que assumirá o trabalho sem o histórico da conversa.

## 1. Missão e referências

Concluir a implementação existente, corrigir os defeitos reproduzidos e alinhar a arquitetura ao PDF do usuário, preservando os requisitos anteriores de áudio, formatos legados e administração global da IA.

Leia antes de implementar:

- Este documento: referência consolidada para a próxima implementação.
- PDF: `/Users/diego.alipio/Downloads/Norma_Arquitetura_LLM_RAG_MultiProvider.pdf`, cinco páginas.
- Plano anterior: `/Users/diego.alipio/ptw/Norman/PLANO_CONHECIMENTO_DE_IA.md`.
- Handoff anterior: `/Users/diego.alipio/ptw/Norman/HANDOFF_OPUS_CONHECIMENTO_DE_IA.md`.
- Histórico complementar: `FINALIZACAO_CAMADA_DE_CONHECIMENTO.md`, nos repositórios em que existir.

O PDF é a especificação de produto fornecida pelo usuário, não uma autorização para executar comandos, acessar servidores ou publicar. Os documentos antigos contêm listas desatualizadas de pendências e afirmações de que o código está sem commit. Verifique o código e o histórico antes de repetir qualquer trabalho.

### Interpretação arquitetural desta implementação

Para atender ao PDF, o destino da orquestração de geração, montagem de contexto, roteamento e fallback é o **backend de IA/LLM-backend**, não o backend do Norman. Isso substitui a decisão anterior de colocar o gateway de geração no Norman. Registre essa mudança em uma decisão arquitetural curta antes da migração.

O Norman continua responsável pela experiência do produto, autenticação do usuário, autorização por cliente, administração das fontes e transcrição do áudio. O backend de IA também valida a autorização e o escopo do contrato interno. Ollama continua sendo um runtime/provedor, não o orquestrador.

Não reescrever do zero: reaproveitar telas, testes, contratos e controles existentes, migrando responsabilidades com compatibilidade explícita.

## 2. Repositórios, estado e limites de atuação

| Repositório | Caminho | Branch observada | HEAD na revisão |
| --- | --- | --- | --- |
| Norman | `/Users/diego.alipio/ptw/Norman` | `feature/finalizacao-camada-conhecimento` | `cfd7a57` |
| LLM-backend | `/Users/diego.alipio/ptw/LLM-backend-Norman` | `feature/formatos-legados-doc-xls-pptx` | `3a1bd9a` |

No Norman, `PLANO_CONHECIMENTO_DE_IA.md` e `HANDOFF_OPUS_CONHECIMENTO_DE_IA.md` estavam não rastreados. Preserve-os. O LLM-backend estava limpo antes da criação deste documento. Os hashes são uma fotografia, não uma instrução para restaurar checkout.

Regras obrigatórias:

- Conferir `git status`, branch, diferenças existentes e instruções `AGENTS.md` antes de editar.
- Continuar nas branches existentes; não trocar, resetar ou criar branches sem necessidade explicitamente autorizada.
- Implementar, testar e fazer **somente commits locais** relacionados à tarefa.
- Não executar push, abrir/mergear PR, criar tags de publicação, disparar workflows, fazer SSH, reiniciar serviços ou alterar configuração remota.
- Não publicar dev, homologação ou produção. O responsável pela publicação será o usuário com o agente de revisão/publicação, depois deste handoff.
- Não mergear em `develop`. O histórico informa que `feat/google-drive-migration` publica dev; isso deverá ser reconfirmado na futura etapa de publicação, sem mudar branches agora.
- Não rodar backfill geral, reindexação de clientes reais ou migrations em bancos compartilhados. Usar apenas bancos locais descartáveis e dados sintéticos.
- Não copiar credenciais da conversa para arquivos, comandos versionados, logs ou documentação. Não procurar credenciais para contornar a falta de um serviço local.
- Não reduzir cobertura, desabilitar testes ou ajustar expectativas apenas para esconder defeitos.
- Não adicionar comentários novos ao código; explicações arquiteturais pertencem aos documentos. Preservar comentários antigos não relacionados.
- Não fazer amend/rebase de commits anteriores nem incluir alterações alheias.

### Identidade dos commits

Email confirmado nos dois repositórios: `admin@ptwag.com`.
Nomes configurados na revisão: Norman, `Diego Abenicio`; LLM-backend, `Diego Alípio Abenicio`.

Conferir autor e committer antes de commitar. Preservar o nome configurado em cada repositório e usar o email acima para ambos, com configuração por repositório/comando, nunca global. Não inserir atribuições a assistentes, nomes de modelos, `Co-authored-by` de bots ou rodapés de geração automática nas mensagens de commit. A documentação técnica naturalmente pode descrever os provedores que integram o produto.

## 3. O que já existe e deve ser reaproveitado

- Área `/admin/ai-knowledge`, seletor administrativo global, teste antes de ativação, confirmação visual e histórico.
- Permissão `aiKnowledge.manage`; não ampliar para perfis comuns. Conferir a correspondência entre o papel administrativo real e as permissões existentes, sem supor nomes de papel.
- Conexões provisionadas Ollama e Grok, revisões, teste recente, ativação concorrente com conflito e trava `NORMAN_AI_FORCE_CONNECTION`.
- Snapshot de provedor por contexto assíncrono e auditoria inicial de operações.
- Registro de fontes de áudio, validação por assinatura, transcrição via Groq/Whisper e envio apenas de texto ao LLM-backend.
- Fontes estruturadas parcialmente, tokens de marca, notas por documento e dossiê por cliente.
- Extração de PDF, DOCX, XLSX/XLSM, texto e formatos adicionados DOC, XLS e PPTX.
- Recuperação com `clientId` no SQL, busca em descendentes e identificação do modelo/dimensão de embedding.

Isso não significa aceite ponta a ponta. Não reimplementar estruturas já presentes apenas porque o handoff antigo diz que faltam.

## 4. Prioridade imediata: três defeitos confirmados

### P0.1 Consulta de descendentes gera SQL inválido

Arquivo: `LLM-backend/src/documents/document-chunks.service.ts`, cláusula `LIKE ... ESCAPE` do ramo `includeDescendants` (linha 112 na revisão).

Evidência: a expressão SQL real, executada em PostgreSQL embarcado/PGlite com `standard_conforming_strings=on`, retornou `22025: invalid escape string`, com a indicação de que o escape deve ter zero ou um caractere. Os testes atuais usam um query builder falso que traduz essa cláusula para `startsWith`, portanto não detectam o problema.

No Norman, `server/modules/knowledge/knowledge.service.ts`, `retrieveForClient`, captura a falha e retorna `[]`. Isso pode produzir uma resposta sem os trechos, mesmo com acervo disponível; o dossiê pode mascarar parcialmente o defeito.

Implementar:

- Corrigir o escape SQL e o tratamento de `%`, `_` e barra invertida no caminho, mantendo parâmetros vinculados e isolamento por `clientId`.
- Testar a consulta real em PostgreSQL/pgvector local, além dos testes unitários. PGlite pode complementar a prova sintática, mas não substitui o teste da consulta vetorial completa.
- Cobrir raiz, vários níveis, caracteres especiais, cliente com prefixo semelhante, outro cliente com o mesmo caminho e escopo inválido.
- Separar indisponibilidade da busca de resultado legítimo vazio. Não apresentar erro de infraestrutura como se o cliente não tivesse conhecimento.

Aceite: descendentes corretos são recuperados; nenhum outro cliente entra; erro SQL/provedor fica observável e tem comportamento explícito para o usuário.

### P0.2 Remoção não impede o uso posterior da fonte

Arquivos principais:

- Norman: `server/modules/ai-knowledge/ai-knowledge.service.ts`, `processAudioSource` e `removeSource`.
- LLM-backend: `src/ingestion/internal-documents.controller.ts`, `forgetPath`/`scheduleConsolidation`.
- LLM-backend: `src/ingestion/internal-knowledge.controller.ts`, leitura de dossiê.

Evidências:

- A exclusão dos documentos dispara reconsolidação posterior, com atraso padrão de 60 segundos; o dossiê antigo continua consultável. Se o enfileiramento falhar, a chamada apenas registra aviso.
- Em reprodução local: criar áudio, remover a fonte antes de executar a tarefa e então executar a tarefa produziu `isCurrent=false`, `status=studying` e a transcrição gravada no acervo.
- Remover o registro da fonte não equivale necessariamente a remover o arquivo armazenado ou impedir a sincronização de indexá-lo novamente.

Implementar:

- Uma fonte removida/desativada e seus derivados não podem entrar em **novas operações após a confirmação da remoção/desativação**. Aplicar a regra a chunks, notas, dossiê, tokens e caches, não só à tabela de documentos.
- Definir versão de vigência/tombstone e confirmação de invalidação entre serviços. Não devolver sucesso definitivo enquanto o acervo ainda puder usar a fonte. Em falha de coordenação, mostrar operação pendente/falha e impedir uso do estado obsoleto quando necessário.
- Evitar que jobs antigos publiquem resultados: revalidar vigência e versão antes de armazenar/publicar, usando proteção transacional ou equivalente contra a corrida entre checagem e gravação.
- Impedir ressurreição por retry, sincronização de arquivos, reindexação ou reconsolidação atrasada.
- Recalcular derivados assincronamente quando útil, mas excluir imediatamente os derivados contaminados das novas leituras até existir uma versão válida.
- Distinguir apagar original, desativar como conhecimento e reter metadados de auditoria. Não apagar um anexo compartilhado por um projeto sem regra explícita e indicação na interface.

Aceite: testar resposta imediatamente após exclusão, exclusão durante transcrição/ingestão/estudo, queda da fila, repetição da operação e nova sincronização. Uma solicitação já iniciada pode seguir a política de snapshot documentada; a promessa do PDF é sobre novas solicitações.

### P0.3 Áudio com falha não pode ser reenviado corretamente

Arquivo: Norman, `server/modules/ai-knowledge/ai-knowledge.service.ts`, `addAudioSource` e `retrySource`.

Evidência reproduzida: falha antes de gerar transcrição; retry responde `SOURCE_NEEDS_REUPLOAD`; reenvio dos mesmos bytes responde `duplicate=true`, preserva `status=failed` e não agenda tarefa nova.

Implementar:

- Deduplicação deve considerar o ciclo de vida, não simplesmente retornar qualquer fonte vigente com o mesmo hash.
- Reenvio de fonte sem transcrição deve permitir retomar o processamento de forma idempotente; fonte pronta duplicada não deve ser estudada desnecessariamente.
- Evitar duas transcrições em reenvios concorrentes; preservar histórico e identidade/versionamento da fonte.
- Tornar o processamento recuperável após reinício, com fila persistente e tratamento explícito do material temporário necessário à transcrição.
- Se o original já foi descartado, informar claramente que é necessário reenviá-lo e garantir que o reenvio funciona.
- Usar identificador/versionamento no caminho da transcrição: dois áudios diferentes chamados `reuniao.ogg` não podem sobrescrever silenciosamente a mesma fonte.

Aceite: falha transitória seguida de reenvio funciona; upload duplicado pronto é idempotente; reinício e concorrência não perdem nem duplicam trabalho; fonte desativada não revive implicitamente.

## 5. Gateway no backend de IA e contexto único

### Responsabilidades e migração

- Norman: sessão, permissões, cliente autorizado, UI administrativa, fontes e entrada/transcrição de áudio.
- Backend de IA: execução de geração, aplicação das regras, construção de contexto, RAG, adapters, streaming, fallback e registro da execução efetiva.
- Ollama/Grok/OpenAI/outros: geração por contrato de provedor; extração, estudo e embeddings mantêm configuração independente da escolha de geração.

Antes de mover código, mapear todas as entradas de chat, briefing, workflow, streaming, workers e demais gerações. Hoje há chamadas diretas em `server/gemini.ts`. Em `server/modules/ai/ai.service.ts`, a geração final após `BRIEFING_READY` chama `generateBriefing` sem reaplicar explicitamente os blocos de conhecimento; a extração de briefing de documento também precisa entrar no mapeamento.

Implementar um contrato interno versionado para operações com identidade autorizada, cliente quando aplicável, funcionalidade, correlação, parâmetros permitidos e mensagens. Não permitir URL, segredo, prompt de sistema privilegiado ou cliente arbitrário vindo do navegador. Operações genéricas sem cliente devem ser explícitas e não consultar conhecimento de clientes.

Definir uma única fonte de verdade para configuração/ativação e para vigência das fontes. É aceitável preservar o banco administrativo do Norman como plano de controle e o backend de IA como executor, desde que o contrato autenticado carregue/referencie revisões imutáveis e o executor resolva somente conexões provisionadas. Não criar duas seleções ativas independentes nem confiar em parâmetros externos arbitrários.

Capturar o snapshot no início da operação, incluindo etapas subsequentes e workers. Conservar a conexão/modelo durante a operação; novas operações devem observar a ativação confirmada inclusive em réplicas distintas. Corrigir/incluir testes para o cache local de 5 segundos, sem prometer troca imediata enquanto outro processo puder usar valor velho.

Todas as etapas que precisam de conhecimento devem receber o mesmo contexto autorizado e sua procedência, inclusive a transformação final em briefing. A pasta do projeto pode priorizar resultados, mas não excluir os conhecimentos gerais relevantes nem outras fontes autorizadas do mesmo cliente.

Não misturar vetores de modelos/dimensões incompatíveis. Definir tratamento explícito dos chunks antigos sem identificação de modelo; não aceitar compatibilidade desconhecida silenciosamente. Preparar reindexação controlada, sem executá-la em acervos reais.

Manter compatibilidade temporária entre versões dos dois serviços, documentando ordem de migração e rollback. Não manter duas orquestrações concorrentes permanentes.

## 6. Provedor/modelo e fallback explícito

- Reutilizar select, teste recente, confirmação, histórico, compare-and-swap e trava operacional existentes.
- Oferecer seleção administrativa de provedor e modelo entre configurações provisionadas/permitidas. Trocar o modelo cria uma revisão e exige teste correspondente; não reaproveitar aprovação de configuração diferente.
- Preparar conexões Ollama, Grok e OpenAI sem inventar chave nem nome de modelo atual. Ausência de configuração aparece como indisponível, não como sucesso.
- APIs compatíveis podem reutilizar transporte; provedores incompatíveis exigem adapter e declaração de capacidades. Um link sozinho não garante compatibilidade.
- Protocolo, streaming, limites, resposta estruturada, timeout e cancelamento devem fazer parte dos testes de contrato.
- Chaves e endpoints sensíveis ficam somente nos servidores apropriados. Permitir referências de ambiente apenas por allowlist; validar URL e rejeitar credenciais embutidas e destinos não provisionados.
- Fallback fica desabilitado por padrão. Quando configurado por administrador, registrar provedor principal, alternativo permitido, causas que autorizam a troca e limites de tentativas.
- Não fazer fallback em erro de autorização, isolamento, payload inválido ou configuração inválida. Não trocar o provedor no meio de um stream já entregue nem concatenar respostas de dois provedores.
- Registrar cada tentativa e o provedor realmente usado. A política deve considerar que fallback pode enviar dados para outro fornecedor e precisa ser visível, autorizada e compatível com as regras de tratamento de dados.

Aceite: ativação concorrente, modelo alterado, réplica diferente, operação em andamento, conexão ausente, falha permitida/não permitida, streaming parcial e segredo sentinela cobertos. Testes reais de provedores sem credenciais ficam explicitamente pendentes, não simulados como aceite real.

## 7. Fontes unificadas e outputs administrativos

Hoje a rota de fontes aceita somente `audio`; documentos entram pelo Repositório. `knowledge_sources` e sua interface devem cobrir de fato documento, texto e áudio/transcrição.

Implementar na mesma aba:

- **Conhecimentos gerais do cliente**: listar, enviar, consultar original/transcrição, substituir com versão, desativar, reativar explicitamente quando permitido, excluir e reprocessar fontes do cliente.
- **Aprendizados por cliente**: conteúdo das notas por documento, guia de marca, dossiê e tokens; modelo, versão, data, vigência e fontes de origem.
- Mostrar o conteúdo das notas, não apenas contagem e nome do modelo, como ocorre hoje em `client/src/features/ai-knowledge/ai-knowledge-screen.tsx`.
- Apresentar estados de erro, processamento, exclusão pendente, desatualização e acervo realmente vazio de forma distinta.
- Ter fonte/versionamento canônico entre Repositório e área administrativa, sem duplicar a ingestão ou perder o vínculo de procedência.
- Garantir que cores, tipografias, identificadores e restrições tenham fonte e versão rastreáveis. Revisão do gerador não substitui versão da fonte.
- Não substituir/apagar tokens persistidos quando uma falha transitória de consulta devolver dossiê nulo. Diferenciar ausência legítima de indisponibilidade.
- Preservar histórico necessário à auditoria sem continuar oferecendo conteúdo revogado ao contexto de novas gerações.

Preservar DOC, XLS e PPTX, além dos formatos anteriores, do upload até a resposta; adicionar testes de regressão com binários reais. Não assumir que todo formato legado é legível: variante não suportada, senha, corrupção e limites devem gerar erro claro. Imagem solta, ZIP e abertura de documento com senha não são novas promessas deste plano; documentar o suporte efetivo. Não implementar importação arbitrária de URL sem definição e proteção de acesso externo.

## 8. Conhecimento candidato e aprovação administrativa

O PDF não pede que toda fala vire conhecimento oficial automaticamente.

- Separar fonte de projeto, material candidato e conhecimento oficial/vigente.
- Permitir sugerir conhecimento da conversa ou de um output estruturado com origem, autor, cliente e versão identificados.
- Somente administradores aprovam/rejeitam e promovem material para o acervo oficial. Aprovação/rejeição gera auditoria.
- Upload administrativo intencional pode ser publicação explícita, com confirmação clara; não exigir uma segunda aprovação artificial do mesmo ato sem necessidade.
- Anexos enviados por usuários comuns ao criar projetos não devem ganhar autoridade global por um observador de sincronização. Podem ser utilizados no projeto conforme autorização, mas a promoção ao conhecimento geral exige a regra de aprovação.
- Conteúdo candidato/rejeitado não entra na busca oficial, dossiê ou tokens. Não promover automaticamente o acervo antigo com migração genérica; preparar inventário/dry-run para decisão posterior.
- Não habilitar aprovação automática nesta entrega. Regras futuras para outputs internos confiáveis precisam de política explícita, não inferência do modelo.

Aceite: candidato não altera a resposta oficial; aprovação altera somente o cliente correto; rejeição e revogação não deixam derivados ativos; pessoa sem permissão não consegue promover pela API.

## 9. Recuperação confiável, citações e auditoria

Hoje a busca retorna apenas `content` e a auditoria de `server/gemini.ts` não passa `clientId`, embora o schema aceite esse campo. Corrigir o contrato inteiro, não apenas adicionar colunas.

- Cada trecho deve carregar identificação de documento/fonte, versão, chunk, página/localização quando disponível e relevância. Não fabricar paginação em formatos que não a possuem.
- Preservar metadados no contexto, na resposta estruturada de citações e na auditoria. Links para fontes exigem autorização; não expor URL pública permanente ou assinada em logs.
- Registrar correlação, funcionalidade real, cliente/escopo, ativação/revisão, modelo, parâmetros relevantes, tentativas/fallback, latência, resultado e uso de tokens quando informado pelo provedor.
- Registrar IDs e versões dos trechos, dossiê e tokens usados. Não gravar indiscriminadamente prompts, documentos ou transcrições integrais nos logs.
- Definir orçamento de contexto e critério de evidência suficiente com testes. Similaridade alta sozinha não prova que uma resposta é verdadeira.
- Na ausência de conhecimento confiável, informar que a informação não foi encontrada no acervo. Em indisponibilidade técnica, informar impossibilidade de consultar; não fingir ausência e não inventar fatos do cliente.
- Tratar documentos como dados não confiáveis. Testar prompt injection em fontes e assegurar que não altera instruções privilegiadas, escopo ou conexão escolhida.
- Remoção/retificação deve invalidar contexto derivado, sem depender de o modelo obedecer a um aviso textual.

## 10. Segurança operacional e reutilização

### Implementar e validar localmente

- Autenticação entre serviços, autorização por cliente em todas as consultas/mutações e proteção contra referências a fontes de outro cliente.
- Validação de uploads, tamanhos, assinaturas, limites de extração, arquivos corrompidos e descompactação de formatos Office, sem executar macros/conteúdo ativo.
- Auditoria administrativa de upload, substituição, desativação, remoção, aprovação e troca de provedor/modelo, com erro redigido.
- Política configurável de retenção de áudio temporário, transcrição, conversas e auditoria; documentar descarte, jobs interrompidos e recuperação. Não definir prazo de negócio definitivo em nome do usuário nem adotar retenção ilimitada como padrão silencioso.
- Descrever ambientes separados e validar configuração de destino antes de qualquer restart. Revisar o pipeline local para usar o `deploy/deploy.sh` validado, sem executar ou publicar o workflow.
- Documentar variáveis por ambiente, rollback, saúde, filas, falhas de ingestão, latência e política de alertas, sem valores secretos.

### Dependências que não podem ser declaradas concluídas apenas por código

- Prazo definitivo de retenção exige decisão do responsável pelos dados.
- Garantias de não treinamento/retenção de fornecedores exigem verificação da conta, configuração e termos aplicáveis. Não prometer que um parâmetro de código, sozinho, resolve isso.
- Separação efetiva das VPS/instâncias, restrição de endpoints expostos e autenticação de Redis exigem a etapa operacional autorizada. Preparar procedimento; não alterar servidores nesta tarefa.

### Niprofe

O PDF pede que outro produto possa reutilizar o gateway, inclusive em recursos multimodais. Preparar contrato autenticado por aplicação/organização, capacidades e testes com consumidor fictício. Não remover o isolamento de pessoa/organização que já existir no LLM-backend para acomodar o escopo de cliente do Norman.

Deixar explícito quais operações multimodais estão realmente implementadas. A integração real do Niprofe depende do repositório e contrato desse produto: registrar a pendência sem editar um terceiro projeto não colocado em escopo. A exceção de áudio permanece: o áudio do Norman é transcrito antes de chegar ao LLM-backend.

## 11. Sequência de implementação e testes

1. Conferir estado dos dois repositórios e registrar inventário do que já está pronto.
2. Criar testes de regressão dos três defeitos confirmados e corrigi-los.
3. Registrar decisão arquitetural, contratos, responsabilidade pelos dados, invalidação e estratégia de compatibilidade.
4. Migrar a orquestração e unificar contexto em todas as entradas de geração.
5. Completar provedor/modelo, fallback explícito e auditoria de execução.
6. Completar fontes unificadas, jobs de áudio, vigência e gestão dos derivados.
7. Implementar aprovação e governança do conhecimento oficial.
8. Completar a tela de fontes/outputs e testes reais de componente.
9. Completar citações, comportamento sem evidência, segurança e contratos de reutilização.
10. Rodar validações, revisar diferenças e documentar pendências externas.
11. Criar commits locais pequenos por responsabilidade em cada repositório e entregar os hashes, sem push.

### Validações obrigatórias

No Norman: `npm run check`, `npm run build`, `npm test`, `npm run test:coverage`, preservando os pisos existentes.
No LLM-backend: `npm run typecheck`, `npm run build`, `npm test` e os gates existentes.
Nos dois: `git diff --check`, revisão das migrations e testes de integração em banco/fila locais descartáveis.

Não esconder integrações ignoradas dentro de uma contagem global verde. Se PostgreSQL/pgvector, Redis, Ollama ou credenciais de provedor não estiverem disponíveis, separar o que foi validado com serviços reais do que foi testado com doubles, e entregar o comando reproduzível que falta executar.

Na revisão de 08/09, antes de implementar este documento:

- Norman: 518 testes passaram e 4 foram ignorados nas áreas selecionadas; não foi uma execução da suíte inteira nem do gate de cobertura.
- LLM-backend: 299 passaram e 22 de integração foram ignorados na suíte executada.
- Verificação de tipos passou nos dois.
- Os três defeitos da seção 4 foram reproduzidos apesar dos testes verdes.
- Nenhum aceite desta versão foi realizado em dev nessa revisão.

### Matriz mínima de regressão/aceite

| Cenário | Resultado exigido |
| --- | --- |
| Fonte exclusiva de A; pergunta em A e em B | A usa/cita a fonte; B não revela o marcador, mesmo com caminho idêntico |
| Arquivo em outra pasta do mesmo cliente | Conhecimento relevante acessível em chat, briefing final e workflow |
| Remoção/desativação confirmada | Novas operações não usam fonte nem seus derivados |
| Remoção durante job e nova sincronização | Fonte não ressuscita |
| Áudio falha, usuário reenvia os mesmos bytes | Uma nova tentativa válida é iniciada |
| Dois uploads concorrentes e dois nomes iguais | Sem duplicação de estudo ou sobrescrita silenciosa |
| Troca de provedor/modelo durante operação | Operação preserva snapshot; próxima usa ativação confirmada |
| Provedor ausente e fallback desligado | Falha clara; nenhuma troca silenciosa |
| Fallback explicitamente permitido | Tentativa e provedor efetivo auditados, contexto e cliente preservados |
| Fonte candidata, aprovada e revogada | Somente estado oficial vigente influencia o acervo geral |
| Consulta vazia versus serviço fora do ar | Mensagens distintas; sem fatos inventados |
| DOC/XLS/PPTX e áudio | Extração/transcrição, ingestão, nota, dossiê e citação com procedência |
| Usuário comum e cliente não autorizado | UI protegida e API nega acesso; nenhuma consulta com escopo amplo |
| Segredo sentinela e documento com instruções maliciosas | Sem vazamento, mudança de escopo ou de provedor |
| Tela administrativa | Testes renderizam o componente e exercitam ações, permissões, erros e outputs |

## 12. Entrega e o que significa terminar

Entregar um relatório Markdown atualizado com:

- funcionalidades concluídas e arquivos principais;
- decisão arquitetural e contratos entre versões;
- correções com evidência de regressão;
- migrations locais criadas e compatibilidade/rollback;
- comandos executados, resultados e integrações ignoradas com motivo;
- hashes dos commits locais por repositório;
- pendências de decisão, credenciais, integração Niprofe e infraestrutura;
- roteiro de publicação futura e aceite em dev, sem executá-lo.

O aceite futuro em dev deve incluir dois clientes sintéticos, upload real pela tela, extração/transcrição, notas visíveis, resposta com fonte, isolamento negativo, exclusão e troca de provedor. Pode reutilizar o marcador `ORQUIDEA CROMADA 47`, a cor `azul-cobalto` e `knowledge-layer-test.pdf`, mas não depender só desse PDF: testar também os formatos legados e áudio. Se aparecer marcador do outro cliente, interromper o aceite, preservar evidências sem segredos e reportar antes de tentar qualquer ajuste de prompt.

Não chamar de “liberado” um trabalho apenas commitado, testado com mocks ou ainda dependente de aceite externo. A entrega desta tarefa termina em **implementação local verificada e pronta para revisão**, com impedimentos externos explicitamente listados. Push, deploy e aceite nos ambientes permanecem fora da autorização do executor.
