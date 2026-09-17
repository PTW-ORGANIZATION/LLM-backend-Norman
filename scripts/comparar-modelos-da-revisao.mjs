#!/usr/bin/env node
/**
 * O modelo da revisão de arte contra a variante que não raciocina.
 *
 * A medição mostrou onde está a espera: para achar um erro de ortografia o
 * modelo gasta perto de cinco mil tokens de raciocínio e escreve cinquenta de
 * resposta. Não é a leitura nem a escrita — é o raciocínio, e ele é cobrado em
 * tempo. O catálogo do provedor oferece a mesma família em versão que não
 * raciocina.
 *
 * Trocar por ela só vale se ela continuar achando os erros. Este teste roda as
 * duas sobre a arte de controle, que tem três erros conhecidos e plantados —
 * `SELEBRAR`, `FASER` e `AMINHO` — com o prompt real da operação, lido do
 * build. Mede o caso difícil, e não o fácil: a arte é colorida, com texto
 * sobre fundo, que foi justamente o que derrubou os diagnósticos anteriores.
 *
 * Nenhum segredo é impresso — nem a chave, nem o nome do modelo configurado.
 */
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);

const ERROS_PLANTADOS = ['SELEBRAR', 'FASER', 'AMINHO'];
const ARTE = 'src/ingestion/extraction/__fixtures__/imagem-arte-colorida.png';
const SUFIXO = process.env.SUFIXO_SEM_RACIOCINIO || '-0309-non-reasoning';

function doBuild(modulo) {
  for (const base of ['../dist/src/gateway/', '../dist/gateway/']) {
    try {
      return require(`${base}${modulo}.js`);
    } catch {
      continue;
    }
  }
  throw new Error(`o build nao tem ${modulo}; rode npm run build antes`);
}

async function medir({ baseUrl, apiKey, modelo, spec, imagem }) {
  const comecou = Date.now();
  const resposta = await fetch(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: modelo,
      temperature: spec.defaults.temperature,
      max_tokens: spec.defaults.maxTokens,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: spec.systemPrompt },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Revise a ortografia desta arte.' },
            { type: 'image_url', image_url: { url: `data:image/png;base64,${imagem}` } },
          ],
        },
      ],
    }),
  });

  const ms = Date.now() - comecou;
  if (!resposta.ok) {
    const corpo = await resposta.text().catch(() => '');
    return { ms, recusa: `${resposta.status} ${corpo.slice(0, 160)}` };
  }

  const corpo = await resposta.json();
  const texto = String(corpo?.choices?.[0]?.message?.content || '');
  const uso = corpo?.usage || {};
  const achados = ERROS_PLANTADOS.filter((erro) => texto.toUpperCase().includes(erro));

  return {
    ms,
    saida: uso.completion_tokens ?? null,
    raciocinio: uso.completion_tokens_details?.reasoning_tokens ?? null,
    entrada: uso.prompt_tokens ?? null,
    achados,
  };
}

function linha(rotulo, r) {
  if (r.recusa) {
    console.log(`  ${rotulo.padEnd(22)} recusou em ${(r.ms / 1000).toFixed(1)}s: ${r.recusa}`);
    return;
  }
  const faltaram = ERROS_PLANTADOS.filter((erro) => !r.achados.includes(erro));
  console.log(
    `  ${rotulo.padEnd(22)} ${(r.ms / 1000).toFixed(1).padStart(6)}s  `
      + `entrada=${String(r.entrada ?? '-').padStart(5)} saida=${String(r.saida ?? '-').padStart(4)} `
      + `raciocinio=${String(r.raciocinio ?? '-').padStart(5)}  `
      + `achou ${r.achados.length}/${ERROS_PLANTADOS.length}`
      + (faltaram.length > 0 ? ` (faltou: ${faltaram.join(', ')})` : ''),
  );
}

const baseUrl = (process.env.GROK_BASE_URL || '').trim();
const apiKey = (process.env.GROK_API_KEY || '').trim();
const modelo = (process.env.GROK_MODEL || '').trim();

if (!baseUrl || !apiKey || !modelo) {
  console.log('faltou GROK_BASE_URL, GROK_API_KEY ou GROK_MODEL; a comparacao nao rodou');
  process.exit(0);
}

try {
  const spec = doBuild('feature-registry').featureSpec('proof_review_visual');
  if (!spec) throw new Error('a operacao proof_review_visual nao existe neste build');

  const imagem = (await readFile(path.resolve(process.cwd(), ARTE))).toString('base64');

  // A comparacao decide se vale trocar; esta linha decide se a troca ja esta
  // valendo. O gateway so executa a variante que a conexao permite, e a
  // checagem aqui e a mesma funcao que ele usa -- nao uma imitacao dela.
  const permitidos = (process.env.GROK_ALLOWED_MODELS || '')
    .split(',').map((m) => m.trim()).filter(Boolean);
  const emUso = doBuild('provider-connection').modeloSemRaciocinio(
    modelo,
    permitidos.includes(modelo) ? permitidos : [modelo, ...permitidos],
  );
  console.log(emUso
    ? 'a conexao ja permite a variante sem raciocinio; a revisao de arte executa nela'
    : `a conexao NAO permite variante sem raciocinio: a revisao de arte segue no modelo da revisao. `
      + `Para ativar, acrescente a GROK_ALLOWED_MODELS o id "${modelo}${SUFIXO}"`);
  console.log('');

  console.log(`arte de controle com ${ERROS_PLANTADOS.length} erros plantados, prompt real da operacao:`);
  linha('modelo de hoje', await medir({ baseUrl, apiKey, modelo, spec, imagem }));
  linha('sem raciocinio', await medir({ baseUrl, apiKey, modelo: `${modelo}${SUFIXO}`, spec, imagem }));

  // A pessoa troca a conexao ativa na tela de Conhecimento de IA, e a revisao
  // de arte passa a rodar no que ela escolheu -- inclusive num modelo de texto,
  // que nao enxerga. Ninguem verifica visao antes de mandar a imagem: o
  // adaptador declara que o PROTOCOLO transporta imagem, e conta com o provedor
  // recusar o que o modelo nao aguenta.
  //
  // Recusar seria o bom caso: o Norman cai na leitura em separado e a revisao
  // acontece. O caso ruim e o modelo de texto ignorar a imagem e responder do
  // mesmo jeito -- ai a tela recebe uma revisao inventada de uma arte que
  // ninguem viu, com toda a cara de legitima. Esta linha diz qual dos dois e.
  const baseLocal = (process.env.OLLAMA_OPENAI_BASE_URL || '').trim() || 'http://127.0.0.1:11434/v1';
  const modeloLocal = (process.env.OLLAMA_MODEL || '').trim();
  if (modeloLocal) {
    console.log('');
    console.log('e se alguem trocar a conexao ativa para um modelo de texto?');
    const cego = await medir({
      baseUrl: baseLocal, apiKey: (process.env.OLLAMA_API_KEY || '').trim() || 'sem-chave',
      modelo: modeloLocal, spec, imagem,
    });
    linha('modelo que nao ve', cego);
    if (!cego.recusa) {
      console.log(cego.achados.length > 0
        ? '  ::AVISO:: ele respondeu sobre uma arte que nao enxergou, e acertou por acaso ou por chute'
        : '  ele respondeu sem enxergar. Achado nenhum aqui nao prova que ele se cala: veja se `texts` veio vazio');
    }
  }
} catch (erro) {
  console.log(`a comparacao nao terminou: ${erro?.message ?? erro}`);
}
