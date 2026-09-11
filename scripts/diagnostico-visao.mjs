#!/usr/bin/env node
/**
 * Diz, em palavras, se o modelo de visao esta lendo as imagens -- e se o
 * prompt de producao deixa ele transcrever o que leu.
 *
 * Existe porque "nenhum texto extraido" tem causas que pedem consertos
 * opostos, e da tela nao da para distinguir: o modelo pode nao estar
 * instalado, pode nao estar recebendo a imagem, ou pode estar recebendo e
 * preferindo a saida de emergencia do prompt a transcrever. Foi a terceira
 * que aconteceu, e ela e invisivel de qualquer outro lugar.
 *
 * Usa o prompt compilado em dist/, e nao uma copia: copia se descola, e foi
 * justamente o prompt que quebrou. Manda os bytes das fixtures versionadas
 * -- sempre os mesmos -- para que duas execucoes que discordam nao possam
 * discordar por causa da imagem.
 *
 * Cada modelo e medido nos dois lados. Transcrever a imagem legivel nao basta:
 * um prompt que nunca recusa nada faz foto sem texto virar conhecimento vazio.
 *
 * Uso: node scripts/diagnostico-visao.mjs [modelo...]   (depois de npm run build)
 */
import { readFileSync } from 'node:fs';

const CODIGO = 'TOPAZIO';
const PROMPT_SEM_SAIDA = 'Escreva o que está escrito nesta imagem.';

const host = (process.env.OLLAMA_HOST || 'http://127.0.0.1:11434').replace(/\/$/, '');
const timeoutMs = Number(process.env.VISAO_TIMEOUT_MS || 120000);

let prompt;
let declarouAusenciaDeTexto;
try {
  ({ TRANSCRIPTION_PROMPT: prompt, declarouAusenciaDeTexto } = await import(
    new URL('../dist/ollama/vision-prompt.js', import.meta.url)
  ));
} catch {
  console.log('dist/ nao esta construido: rode npm run build antes deste diagnostico');
  process.exit(0);
}

const imagens = {
  'com texto': imagemEmBase64('imagem-com-texto.png'),
  'sem texto': imagemEmBase64('imagem-sem-texto.png'),
};

function imagemEmBase64(nome) {
  const caminho = new URL(`../src/ingestion/extraction/__fixtures__/${nome}`, import.meta.url);
  return readFileSync(caminho).toString('base64');
}

async function perguntar(model, textoDoPrompt, imagemBase64) {
  try {
    const resposta = await fetch(`${host}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        prompt: textoDoPrompt,
        images: [imagemBase64],
        stream: false,
        options: { temperature: 0 },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!resposta.ok) return { erro: `o Ollama recusou a chamada (${resposta.status})` };
    const dados = await resposta.json();
    return { texto: String(dados.response ?? '') };
  } catch (erro) {
    if (erro?.name === 'TimeoutError') return { erro: `nao respondeu em ${timeoutMs} ms` };
    return { erro: String(erro?.message || erro) };
  }
}

/** Uma linha so, sem quebras, para caber no log do deploy. */
function resumir(texto) {
  const limpo = texto.replace(/\s+/g, ' ').trim();
  return limpo.length > 160 ? `${limpo.slice(0, 160)}...` : limpo || '(vazio)';
}

async function modelosInstalados() {
  try {
    const resposta = await fetch(`${host}/api/tags`, { signal: AbortSignal.timeout(15000) });
    return ((await resposta.json()).models ?? []).map((m) => m.name);
  } catch {
    return [];
  }
}

const instalados = await modelosInstalados();
const pedidos = process.argv.slice(2).filter(Boolean);
const alvos = [...new Set(pedidos.length ? pedidos : instalados)];

if (!alvos.length) {
  console.log('nenhum modelo para testar: o Ollama nao respondeu a lista e nenhum foi indicado');
  process.exit(0);
}

for (const modelo of alvos) {
  if (instalados.length && !instalados.some((n) => n === modelo || n === `${modelo}:latest`)) {
    console.log(`modelo ${modelo}: NAO esta instalado neste Ollama`);
    continue;
  }

  // Lado 1: a imagem legivel tem que virar texto com o prompt de producao.
  const legivel = await perguntar(modelo, prompt, imagens['com texto']);
  if (legivel.erro) {
    console.log(`modelo ${modelo}: imagem com texto -- ${legivel.erro}`);
  } else if (legivel.texto.toUpperCase().includes(CODIGO)) {
    console.log(`modelo ${modelo}: imagem com texto -- OK, transcreveu e achou o codigo`);
  } else {
    // Nao achou. O prompt neutro separa "nao le" de "le mas desiste".
    const neutra = await perguntar(modelo, PROMPT_SEM_SAIDA, imagens['com texto']);
    const leComNeutro = !neutra.erro && neutra.texto.toUpperCase().includes(CODIGO);
    console.log(
      leComNeutro
        ? `modelo ${modelo}: imagem com texto -- FALHOU no prompt de producao, mas LE com prompt neutro`
          + ` (o conserto e o prompt) -- devolveu: ${resumir(legivel.texto)}`
        : `modelo ${modelo}: imagem com texto -- FALHOU nos dois prompts (o modelo nao esta lendo a imagem)`
          + ` -- producao: ${resumir(legivel.texto)} | neutro: ${resumir(neutra.texto ?? neutra.erro)}`,
    );
  }

  // Lado 2: a imagem sem palavra alguma tem que ser recusada, e o codigo so
  // reconhece a recusa se ela casar com alguma das formas que ele conhece.
  const vazia = await perguntar(modelo, prompt, imagens['sem texto']);
  if (vazia.erro) {
    console.log(`modelo ${modelo}: imagem sem texto -- ${vazia.erro}`);
  } else if (declarouAusenciaDeTexto(vazia.texto)) {
    console.log(`modelo ${modelo}: imagem sem texto -- OK, recusada e a recusa foi reconhecida`);
  } else {
    console.log(
      `modelo ${modelo}: imagem sem texto -- a recusa NAO foi reconhecida,`
        + ` isto viraria conhecimento vazio -- devolveu: ${resumir(vazia.texto)}`,
    );
  }
}
