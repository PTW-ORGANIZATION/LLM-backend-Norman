# Suíte de contrato entre o Norman e o LLM-backend

Sobe os **dois lados de verdade**, no mesmo processo, e prova a fronteira que
nenhuma das duas suítes isoladas alcança.

## O que é real aqui

| Lado | O que roda de verdade |
| --- | --- |
| LLM-backend | servidor HTTP do Nest, `InternalAuthGuard`, `ValidationPipe` com os DTOs, `InternalGenerationController`, `GenerationService`, `ConnectionRevisionsService`, PostgreSQL embarcado com as migrations de revisões e ativações |
| Norman | `createLlmGatewayClient`, `createGatewayAiAdapter`, `createLlmBackendKnowledgeAdapter`, `createKnowledgeService`, `createAiProviderControlService`, o repository drizzle do plano de controle, PostgreSQL embarcado com as migrations `AI_CONTROL_MIGRATIONS` |

Stubado: **somente os modelos externos** — a geração de texto e o cálculo de
embedding —, e sempre depois de toda a autenticação, validação e autorização.
Nada de autorização é reimplementado num servidor falso: foi exatamente essa
duplicação que deixou os dois defeitos de integração passarem verdes.

Nenhuma dependência de Grok, OpenAI, Ollama, Redis ou infraestrutura remota. O
token interno é de teste.

## Como rodar

O repositório do Norman precisa estar ao lado deste (`../Norman`), ou apontado
por `NORMAN_REPO_PATH`:

```bash
npm run test:contract
```

```bash
NORMAN_REPO_PATH=/caminho/para/Norman npm run test:contract
```

Ela fica fora do `npm test` de propósito: este backend precisa continuar
testável sozinho, sem o outro serviço presente. Quando o Norman não está no
caminho, a suíte **falha** dizendo isso — ela não se ignora em silêncio.

## O que ela prova

1. conversa genérica (sem cliente) autorizada ponta a ponta;
2. conversa por cliente autorizada e isolada do acervo de outro cliente;
3. consumidor restrito recebendo `403` na operação genérica e no escopo de cliente;
4. trava operacional gerando com uma ativação confirmada real;
5. identidade `forced:<chave>` recusada pelo executor;
6. trava sem ativação confirmada falhando antes do cliente do gateway;
7. contrato v1/v2 desencontrado falhando explicitamente;
8. nenhuma URL nem credencial de provedor atravessando o contrato;
9. toda operação que o mapa `GENERIC_FEATURE` do Norman produz autorizada ao
   consumidor `norman` — acrescentar um par genérico lá sem autorizá-lo aqui
   derruba esta suíte;
10. a ingestão do acervo geral do sistema chegando ao executor **sem cliente** e
    no nível `system`, pela rota interna real;
11. a mesma fonte geral compondo a geração dos dois clientes, com o acervo
    privado de cada um restrito a ele;
12. citações distinguindo a camada `client` da camada `system`;
13. retenção da camada geral tirando só ela, com o acervo do cliente intacto;
14. revogação geral confirmada apagando a evidência para os dois clientes, e o
    caminho revogado não voltando pela ingestão seguinte.
