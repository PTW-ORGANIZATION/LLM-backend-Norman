# Finalização da camada de conhecimento do Norman

**Atualizado em:** 04/09/2026  

> ## Estado em 04/09/2026, fim do dia
>
> Esta é a versão V2 da camada de conhecimento. Ela permanece isolada em duas
> branches locais e **não será publicada nem validada em dev agora**. O teste
> atual deve continuar na versão estável que já estava na
> `feat/google-drive-migration` antes destes commits.
>
> **Branches:** `feature/formatos-legados-doc-xls-pptx` (LLM-backend, a partir da
> `main`) e `feature/finalizacao-camada-conhecimento` (Norman, a partir da
> `feat/google-drive-migration` — a `main` do Norman está 211 commits atrás e não
> tem a camada de conhecimento).
>
> | Bloco | Estado |
> | --- | --- |
> | 1. `.doc`, `.xls`, `.pptx` | Implementado, com fixtures binárias reais |
> | 2. Upload de projeto no acervo | Parcial: TXT/MD entram no Repositório; formatos binários continuam fora da tela por decisão de produto |
> | 3. Tela de outputs | Implementada, com reprocessar, regerar e acompanhar a regeneração até terminar |
> | 4. Segundo provedor de texto | Implementado: Grok da xAI, **pronto mas não conectado** (sem chave) |
> | 5. Ambientes, pipeline, segurança | **Não iniciado** |
>
> ### Três coisas que este documento supunha e que não eram verdade
>
> 1. **O bloco do provedor não era do LLM-backend.** O chat dele é escopo de
>    pessoa e não conhece `clientId`. Quem monta contexto e gera resposta com
>    conhecimento de cliente é o Norman — foi lá que o Grok entrou.
> 2. **`server/gemini.ts` do Norman não usa Gemini.** É o SDK da OpenAI apontado
>    para o Ollama; a Groq só responde visão e áudio. O nome do arquivo é legado.
>    Por isso o Grok não precisou de adapter novo: ele fala a mesma API.
> 3. **O workflow de deploy do LLM-backend nunca chama `deploy/deploy.sh`.** Ele
>    reimplementa o deploy, e no caminho automático não roda nenhuma das travas
>    do script: coerência `# AMBIENTE SERVIDO:` × `NORMAN_INTERNAL_URL`,
>    exigência de `https://`, `dist/main.js` existir, nem o health check depois
>    do restart. É item do bloco 5 e continua aberto.
>
> ### Decisões vigentes
>
> 1. Não integrar estas branches V2 à `feat/google-drive-migration`, não publicar
>    o LLM-backend V2 e não rodar o aceite desta versão por enquanto.
> 2. Manter **Novo Projeto → Subir arquivo** restrito a TXT/MD. A extração de
>    binários já é responsabilidade do LLM-backend, mas a tela não será ampliada
>    nesta etapa.
> 3. **Ligar o Grok quando a chave chegar** (hoje não há chave, e por decisão o
>    código só ficou pronto). No ambiente: `GROK_API_KEY`, `GROK_MODEL` — sem
>    padrão de propósito, porque o catálogo da xAI muda — e
>    `AI_TEXT_PROVIDER=grok`. Reiniciar, porque o cliente é construído na carga
>    do módulo. Depois, repetir o aceite de isolamento por cliente nesse
>    provedor. Enquanto não houver chave, nada muda: o provedor em uso é o Ollama
>    e há teste fixando que a ausência do Grok não altera o que roda.
> 4. Manter `clientKnowledge.manage` somente no perfil administrativo até nova
>    decisão.
> 5. Quando a V2 for retomada, integrar no branch que publica dev, validar os
>    formatos com arquivos reais e só depois atacar o bloco 5.


**Objetivo:** descrever o que ainda precisa ser implementado e validado para entregar a camada de conhecimento conforme o briefing original.

## 1. Resultado final esperado

O Norman deve receber arquivos relacionados a um cliente ou projeto, encaminhá-los ao LLM-backend e acompanhar o processamento. O LLM-backend deve extrair e estudar o conteúdo com os modelos locais, gerar conhecimento reutilizável e disponibilizá-lo ao Norman.

Esse conhecimento precisa:

- ficar vinculado ao cliente correto;
- ser separado do conhecimento de todos os outros clientes;
- ser atualizado quando um arquivo for incluído, substituído, movido ou excluído;
- alimentar os chats e briefings do Norman independentemente do provedor de texto escolhido;
- ter seus documentos, estados e outputs visíveis na interface do Norman;
- falhar de forma explícita quando um arquivo não puder ser lido, sem produzir um sucesso vazio.

O fluxo final deve ser:

```text
Arquivo enviado no Norman
  -> arquivo salvo no repositório do cliente/projeto
  -> registro enviado ao LLM-backend
  -> extração de texto ou OCR
  -> divisão em chunks e embeddings
  -> estudo pelo Llama
  -> outputs por documento
  -> dossiê consolidado do cliente
  -> consulta pelo chat e pelos briefings do Norman
  -> visualização do resultado na interface
```

## 2. O que já está funcionando

### 2.1 Entrada e sincronização

- Arquivos do Repositório do Norman, quando estão dentro da pasta reconhecida de um cliente, são registrados no LLM-backend.
- O arquivo continua armazenado no Norman; o LLM-backend busca os bytes por uma rota interna autenticada.
- Alteração de conteúdo é detectada pelo `sha256`.
- Exclusão e renomeação de arquivos ou pastas propagam a mudança para o conhecimento.
- A ingestão é idempotente: o mesmo conteúdo não deve gerar processamento duplicado.

### 2.2 Processamento

- Extração, chunking, embeddings e busca vetorial estão implementados.
- PDF com camada de texto é lido diretamente.
- PDF escaneado usa OCR por visão quando a página não tem texto suficiente.
- Cada documento gera um `document_summary`.
- Manual de marca pode gerar também um `brand_guide`.
- O conjunto de documentos gera um `client_dossier`.
- Identificadores como códigos, slogans e frases-chave têm campo estruturado próprio.

### 2.3 Uso no Norman

- O dossiê do cliente é incluído no contexto do chat e dos briefings quando a requisição contém o `clientId` autorizado.
- A busca por trechos respeita cliente e pasta.
- O Repositório mostra os estados básicos `Lendo`, `No acervo`, `Estudado` e `Não lido`.
- O teste pela tela com o cliente de teste retornou corretamente `ORQUIDEA CROMADA 47`, `azul-cobalto` e `knowledge-layer-test.pdf`.
- O teste com outro cliente não retornou nenhum desses três valores.

### 2.4 Formatos aceitos atualmente

| Categoria | Extensões | Tratamento atual |
| --- | --- | --- |
| PDF | `.pdf` | camada de texto e OCR como fallback |
| Word moderno | `.docx` | extração direta |
| Excel moderno | `.xlsx`, `.xlsm` | uma unidade de extração por aba |
| Texto | `.txt`, `.text`, `.md`, `.markdown`, `.csv`, `.tsv`, `.json`, `.yaml`, `.yml`, `.xml`, `.html`, `.htm`, `.log` | leitura direta |

A extensão do nome tem prioridade sobre o MIME. Isso deve continuar assim porque fontes de armazenamento podem devolver `application/octet-stream` para arquivos válidos.

## 3. O que falta para atender ao briefing completo

### 3.1 Suportar obrigatoriamente `.doc`, `.xls` e `.pptx`

Esses três formatos fazem parte do escopo de aceite e não podem permanecer como melhoria futura.

### `.doc` legado

Implementar um extrator para o formato binário do Word anterior a 2007.

Requisitos:

- extrair parágrafos, tabelas e listas em ordem legível;
- preservar quebras úteis para o chunking;
- não executar macros nem conteúdo incorporado;
- aceitar MIME correto e `application/octet-stream` quando a extensão for `.doc`;
- gerar erro explícito para arquivo corrompido ou protegido, sem criar chunks vazios;
- limpar qualquer arquivo temporário usado na conversão.

### `.xls` legado

Implementar um leitor para o formato binário do Excel anterior a 2007.

Requisitos:

- produzir uma unidade de extração por aba, como já ocorre com `.xlsx`;
- incluir o nome da aba;
- preservar linhas, colunas, datas, números e resultados armazenados de fórmulas;
- lidar com células vazias e mescladas sem deslocar os dados de forma enganosa;
- não executar macros;
- aceitar MIME correto e `application/octet-stream` quando a extensão for `.xls`;
- falhar explicitamente para arquivo inválido ou protegido.

### `.pptx`

Implementar um extrator por slide.

Requisitos:

- cada slide deve ser uma unidade de extração com número próprio;
- extrair título, caixas de texto, listas, tabelas, gráficos com rótulos textuais e notas do apresentador;
- manter a ordem de leitura mais próxima possível da ordem visual;
- aplicar OCR às imagens do slide ou ao slide renderizado quando o texto extraído for insuficiente;
- impedir que um deck composto por imagens entre no acervo como documento vazio;
- aceitar MIME correto e `application/octet-stream` quando a extensão for `.pptx`;
- falhar explicitamente para apresentação inválida ou protegida.

### Alterações comuns aos três formatos

- ampliar `DocumentKind` e `ExtractionSource`;
- incluir as extensões e MIME types no detector;
- ligar os novos extratores ao `TextExtractionService`;
- adicionar dependências de runtime e pacotes do sistema à imagem de deploy, se necessários;
- impor limites de tamanho, quantidade de páginas/abas/slides, tempo e memória;
- registrar a origem de extração usada;
- adicionar fixtures reais, não apenas buffers fictícios;
- validar o caminho completo: upload, extração, chunks, notas, dossiê e resposta do chat.

### 3.2 Fazer os uploads de projeto entrarem no conhecimento

Na V2 local, TXT e MD enviados em **Novo Projeto → Subir arquivo** são guardados no Repositório do cliente e seguem o fluxo normal de conhecimento. A tela continua restrita a esses formatos por decisão tomada em 04/09/2026.

Quando uma rota do Norman precisar extrair um documento binário, os bytes são enviados por multipart para uma rota interna autenticada do LLM-backend. O LLM-backend aplica o mesmo detector por extensão, os mesmos extratores e os mesmos limites usados pela ingestão do Repositório. O provedor de chat do Norman não extrai mais binários.

Permanece fora desta etapa permitir PDF, DOC, DOCX, XLS, XLSX, PPT ou PPTX diretamente na tela de Novo Projeto.

Para completar futuramente o briefing original, será necessário decidir se os formatos binários também devem aparecer nessa tela. A regra atual para arquivos aceitos é:

1. todo arquivo de projeto aceito é salvo no Repositório, dentro do cliente e do projeto; e
2. a ingestão e o estudo acontecem de forma assíncrona pelo LLM-backend.

Em qualquer opção:

- o upload só pode entrar no acervo depois de existir um `clientId` válido;
- a interface deve mostrar em qual cliente e pasta o arquivo será guardado;
- a mesma identidade de arquivo deve ser usada pelo Repositório e pelo LLM-backend;
- reenvio, substituição e exclusão precisam atualizar o conhecimento;
- um upload não pode bloquear a criação do projeto enquanto o estudo assíncrono acontece;
- o usuário deve conseguir acompanhar o estado do processamento.

### 3.3 Mostrar os outputs na interface

Os outputs podem ser inspecionados na tela **Conhecimento do cliente**, acessível somente ao perfil administrativo nesta etapa.

A tela foi implementada com permissão administrativa própria.

A tela deve mostrar:

- documentos incluídos no acervo;
- nome, pasta, tipo, tamanho, hash e data da última atualização;
- estado `pending`, `processing`, `ready` ou `failed` em linguagem amigável;
- motivo completo da falha e ação de tentar novamente;
- quantidade de chunks;
- fonte da extração, por exemplo `pdf-text-layer`, `pdf-ocr`, `doc`, `xls` ou `pptx`;
- preview do `document_summary`;
- preview do `brand_guide`, quando existir;
- preview do `client_dossier` consolidado;
- modelo, versão do gerador e data de geração de cada output;
- ação para reprocessar um documento;
- ação para regerar o dossiê do cliente, mantendo a atualização automática enquanto o job estiver na fila;
- indicação clara de que excluir um arquivo também o remove do conhecimento.

Não exibir embeddings, tokens internos, segredos ou prompts de sistema para usuários comuns. Uma visualização técnica opcional pode existir apenas para administradores.

### 3.4 Garantir acesso pelo provedor de IA desejado

O texto do briefing menciona “Grok/Grook” e Llama. A V2 local tem:

- **Ollama/Llama** para chat, briefing, estudo e geração dos outputs;
- **Groq** para áudio e funções auxiliares;
- **Grok da xAI** disponível como provedor de texto selecionável, mas sem chave e sem modelo configurados.

O segundo provedor definido é o Grok da xAI. O Ollama continua como padrão e a ausência das variáveis do Grok não altera o comportamento atual.

Em ambos os casos, a montagem do contexto deve continuar fora do adapter. Assim, o mesmo dossiê e os mesmos trechos isolados por cliente chegam a qualquer provedor de texto selecionado.

O aceite deve repetir a mesma pergunta positiva e a mesma prova de isolamento em cada provedor suportado.

### 3.5 Separar e automatizar os ambientes

Ainda existe um único LLM-backend com um único `NORMAN_INTERNAL_URL`. Isso impede que dev e produção sejam atendidos com segurança pela mesma instância.

Para produção, criar instâncias separadas de LLM-backend para dev e produção, cada uma com:

- `NORMAN_INTERNAL_URL` do próprio ambiente;
- banco separado;
- índice ou instância de Redis separado;
- filas separadas;
- token interno diferente;
- configuração e logs identificando o ambiente;
- modelos e limites declarados explicitamente.

Também falta um pipeline próprio do LLM-backend. Ele deve:

- rodar typecheck, testes e build;
- construir uma imagem reproduzível;
- validar todas as variáveis obrigatórias antes do restart;
- impedir URL de produção em instância de dev e vice-versa;
- executar migrations de forma controlada;
- publicar com health check e rollback;
- registrar commit e imagem em execução;
- nunca restaurar `.env` por cópia manual durante o deploy.

### 3.6 Fechar segurança e operação

Antes de produção:

- retirar o Ollama de exposição pública ou protegê-lo por rede privada/autenticação;
- configurar autenticação no Redis e restringir acesso por firewall;
- rotacionar segredos que tenham sido compartilhados fora do cofre oficial;
- centralizar segredos no mecanismo de deploy;
- adicionar métricas de fila, duração, falhas, OCR e consumo de GPU;
- criar alerta para documentos presos em `pending` ou `processing`;
- definir retenção de logs sem gravar conteúdo sensível dos documentos;
- documentar retry, reprocessamento e recuperação após indisponibilidade.

## 4. Testes obrigatórios

### 4.1 Matriz por formato

Criar pelo menos um arquivo real para cada formato suportado. Cada arquivo deve conter valores exclusivos e conhecidos para que a extração seja verificável.

| Formato | Conteúdo mínimo do fixture | Evidência esperada |
| --- | --- | --- |
| `.pdf` textual | parágrafos e identificador literal | fonte `pdf-text-layer`, chunks e resposta correta |
| `.pdf` escaneado | texto apenas como imagem | fonte `pdf-ocr`, chunks e resposta correta |
| `.docx` | parágrafos e tabela | texto preservado e resposta correta |
| `.doc` | parágrafos e tabela | texto preservado e resposta correta |
| `.xlsx` | duas abas, datas, números e fórmula | uma unidade por aba e valores corretos |
| `.xls` | duas abas, datas, números e fórmula | uma unidade por aba e valores corretos |
| `.pptx` | texto, tabela, notas e slide com imagem | uma unidade por slide, OCR quando necessário e resposta correta |
| texto puro | UTF-8, acentos e linhas | conteúdo normalizado sem perda relevante |

Para cada formato, testar também:

- extensão em maiúsculas;
- MIME correto;
- MIME `application/octet-stream`;
- arquivo vazio;
- arquivo corrompido;
- arquivo protegido, quando aplicável;
- atualização do mesmo caminho com novo conteúdo;
- exclusão após ingestão;
- nome com espaço e acento.

### 4.2 Testes de conhecimento

- Todo documento válido chega a `ready` e possui pelo menos um chunk.
- Todo documento válido gera `document_summary`.
- Documento reconhecido como manual de marca gera `brand_guide`.
- Alteração do acervo regenera o `client_dossier`.
- Conteúdo idêntico não gera trabalho duplicado.
- Falha de uma nota não apaga chunks válidos nem finge sucesso.
- Arquivo excluído deixa de aparecer no dossiê e nas buscas.
- Arquivo movido dentro do mesmo cliente mantém o conhecimento.
- Movimento entre clientes é rejeitado ou tratado como remoção e nova ingestão, nunca como simples rename.

### 4.3 Testes pela interface

Para cada provedor de texto habilitado:

1. selecionar um cliente com acervo;
2. abrir uma conversa limpa;
3. perguntar por valores exclusivos de um dos documentos;
4. confirmar valor, contexto e nome do documento de origem;
5. abrir outra conversa limpa com um cliente sem aquele documento;
6. repetir exatamente a pergunta;
7. confirmar que nenhum valor exclusivo aparece.

Se qualquer valor aparecer no segundo cliente, preservar logs e interromper a liberação. Isso é vazamento entre clientes e não deve ser tratado como problema de prompt.

### 4.4 Testes da interface de outputs

- O estado muda de `Lendo` para `Estudado` sem recarregar manualmente a página.
- Falha mostra o motivo e a opção de retry.
- O resumo exibido corresponde ao documento correto.
- O dossiê exibido corresponde ao cliente selecionado.
- Usuário sem permissão não acessa outputs técnicos.
- Reprocessamento atualiza versão, data e conteúdo apresentados.

## 5. Ordem recomendada de execução

1. Manter as branches V2 separadas enquanto a versão estável é testada.
2. Quando a V2 for retomada, decidir se formatos binários entram também por **Novo Projeto**.
3. Integrar o Norman V2 somente à `feat/google-drive-migration`, nunca à `develop` para este teste.
4. Publicar os dois serviços em dev e validar `.doc`, `.xls` e `.pptx` com arquivos reais.
5. Rodar o aceite completo e o isolamento em um único cliente de teste.
6. Ligar e validar o Grok quando houver chave e modelo definidos.
7. Criar o pipeline do LLM-backend e separar dev de produção.
8. Fechar segurança e observabilidade.
9. Rodar o backfill em um único cliente real escolhido e conferir custo, tempo e qualidade.
10. Só então planejar o backfill restante e a promoção para produção.

## 6. Fora do escopo desta finalização

Salvo nova decisão, estes itens continuam fora:

- `.ppt` binário antigo;
- imagem solta como documento (`.jpg`, `.jpeg`, `.png`, `.webp`, `.tiff`);
- PDF protegido por senha sem que a senha seja fornecida por fluxo seguro;
- arquivos compactados como `.zip`;
- áudio e vídeo como fonte permanente de conhecimento.

Imagens dentro de `.pptx` não estão fora do escopo: precisam de OCR quando forem necessárias para que o slide não perca seu conteúdo textual.

## 7. Definição de pronto

A camada de conhecimento estará finalizada quando todos os itens abaixo forem verdadeiros:

- [ ] Arquivos enviados pelo Repositório e pelo fluxo de projeto podem entrar no acervo do cliente. *(Repositório e TXT/MD do projeto estão implementados; binários no fluxo de projeto foram adiados)*
- [x] `.doc`, `.docx`, `.xls`, `.xlsx`, `.xlsm`, `.pptx`, `.pdf` e os formatos de texto listados são suportados. *(implementado; não validado em dev)*
- [x] Arquivo válido nunca termina em sucesso sem chunks. *(corrompido, protegido e grande demais agora falham explicitamente e não repetem na fila)*
- [x] Documento, notas e dossiê podem ser vistos e reprocessados pela interface, incluindo acompanhamento da regeneração. *(implementado localmente; não validado em dev)*
- [ ] Chat e briefings recebem conhecimento do cliente selecionado.
- [ ] O acesso funciona em todos os provedores de texto definidos para o Norman. *(Grok implementado e selecionável; falta rodar o aceite nele)*
- [ ] Os testes de isolamento passam em todos esses provedores.
- [ ] Dev e produção possuem instâncias, filas, bancos, tokens e URLs separados. *(bloco 5, não iniciado)*
- [ ] O LLM-backend possui deploy automatizado, validado e reversível. *(o workflow existe mas ignora o deploy.sh e não tem health check nem rollback)*
- [ ] Segurança de Ollama, Redis e segredos foi fechada.
- [ ] Backfill foi validado primeiro em um único cliente.
- [ ] Produção só foi promovida depois do aceite funcional e operacional.

## 8. Resumo executivo do que falta

O núcleo de conhecimento já funciona: o Norman registra arquivos do Repositório, o LLM-backend extrai e estuda, os outputs são gerados e o chat usa o dossiê com isolamento por cliente.

A V2 local já contém os extratores de `.doc`, `.xls` e `.pptx`, a tela de outputs, retry, regeneração acompanhada e o Grok preparado sem chave. A extração binária síncrona do Norman também foi movida para uma rota interna autenticada do LLM-backend. O PPTX possui limite do pacote compactado, do conteúdo descompactado, de slides e de imagens enviadas ao OCR.

Continuam pendentes:

1. decidir se formatos binários devem entrar diretamente por **Novo Projeto**;
2. validar a V2 em dev com arquivos reais e repetir o teste de isolamento;
3. conectar e validar o Grok quando houver chave;
4. separar ambientes e criar pipeline reproduzível, health check e rollback;
5. fechar segurança, observabilidade e rotação de segredos;
6. validar o backfill primeiro em um único cliente.

Por decisão de 04/09/2026, essas pendências não bloqueiam o teste atual da versão estável: as branches V2 permanecem separadas e sem publicação até a retomada deste trabalho.
