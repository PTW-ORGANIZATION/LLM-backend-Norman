#!/usr/bin/env node
/**
 * Diz, em palavras, se o modelo de visao consegue ler uma imagem.
 *
 * Existe porque "nenhum texto extraido" tem causas que exigem consertos
 * opostos, e da tela nao da para distinguir: o modelo pode nao estar
 * recebendo a imagem, pode nao ter visao, ou pode estar preferindo a saida
 * de emergencia do prompt a transcrever. Roda no deploy e tambem na mao,
 * na propria maquina, sem depender de alguem subir arquivo pela interface.
 *
 * Manda os bytes da fixture versionada -- os mesmos sempre. Quando duas
 * execucoes discordam, a imagem nao e a variavel.
 *
 * Uso: node scripts/diagnostico-visao.mjs [modelo...]
 */
import { readFileSync } from 'node:fs';

const FIXTURE = new URL(
  '../src/ingestion/extraction/__fixtures__/imagem-com-texto.png',
  import.meta.url,
);
const CODIGO = 'TOPAZIO';

// O prompt de producao entrega ao modelo uma saida de uma palavra. Se ele a
// tomar, o segundo prompt -- que nao a oferece -- separa as duas causas: com
// o prompt neutro o modelo que ve a imagem transcreve, e o que nao a recebe
// continua sem ter o que dizer.
const PROMPT_DE_PRODUCAO = [
  'Transcreva literalmente todo o texto visível nesta imagem.',
  'Não descreva a imagem, não traduza e não resuma.',
  'Não adicione títulos, rótulos, marcadores nem comentários seus.',
  'Se não houver nenhum texto legível, responda exatamente NENHUM_TEXTO.',
].join(' ');

const PROMPT_SEM_SAIDA = 'Escreva o que está escrito nesta imagem.';

const host = (process.env.OLLAMA_HOST || 'http://127.0.0.1:11434').replace(/\/$/, '');
const timeoutMs = Number(process.env.VISAO_TIMEOUT_MS || 180000);

async function perguntar(model, prompt, imagemBase64) {
  const resposta = await fetch(`${host}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      prompt,
      images: [imagemBase64],
      stream: false,
      options: { temperature: 0 },
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!resposta.ok) {
    return { erro: `o Ollama recusou a chamada (${resposta.status})` };
  }
  const dados = await resposta.json();
  return { texto: String(dados.response ?? '') };
}

/** Uma linha so, sem quebras, para caber no log do deploy. */
function resumir(texto) {
  return texto.replace(/\s+/g, ' ').trim().slice(0, 180);
}

async function modelosInstalados() {
  try {
    const resposta = await fetch(`${host}/api/tags`, { signal: AbortSignal.timeout(15000) });
    const dados = await resposta.json();
    return (dados.models ?? []).map((m) => m.name);
  } catch {
    return [];
  }
}

const imagemBase64 = readFileSync(FIXTURE).toString('base64');
const instalados = await modelosInstalados();

const pedidos = process.argv.slice(2).filter(Boolean);
const alvos = [...new Set(pedidos.length ? pedidos : instalados)];

if (!alvos.length) {
  console.log('nenhum modelo para testar: o Ollama nao respondeu a lista e nenhum foi indicado');
  process.exit(0);
}

console.log(`imagem de teste: ${imagemBase64.length} caracteres em base64, com o codigo ${CODIGO}`);

for (const modelo of alvos) {
  if (instalados.length && !instalados.some((nome) => nome === modelo || nome === `${modelo}:latest`)) {
    console.log(`modelo ${modelo}: NAO esta instalado neste Ollama`);
    continue;
  }

  const primeira = await perguntar(modelo, PROMPT_DE_PRODUCAO, imagemBase64).catch((erro) => ({
    erro: erro?.name === 'TimeoutError' ? `nao respondeu em ${timeoutMs} ms` : String(erro?.message || erro),
  }));

  if (primeira.erro) {
    console.log(`modelo ${modelo}: ${primeira.erro}`);
    continue;
  }

  if (primeira.texto.toUpperCase().includes(CODIGO)) {
    console.log(`modelo ${modelo}: LEU a imagem com o prompt de producao`);
    continue;
  }

  const disseQueNaoTemTexto = primeira.texto.toUpperCase().includes('NENHUM_TEXTO');
  const segunda = await perguntar(modelo, PROMPT_SEM_SAIDA, imagemBase64).catch((erro) => ({
    erro: erro?.name === 'TimeoutError' ? `nao respondeu em ${timeoutMs} ms` : String(erro?.message || erro),
  }));

  if (segunda.erro) {
    console.log(`modelo ${modelo}: falhou no prompt neutro -- ${segunda.erro}`);
    continue;
  }

  if (segunda.texto.toUpperCase().includes(CODIGO)) {
    console.log(
      `modelo ${modelo}: LE a imagem, mas o PROMPT DE PRODUCAO o faz desistir`
        + `${disseQueNaoTemTexto ? ' (respondeu a sentinela NENHUM_TEXTO)' : ''}`
        + ' -- o conserto e o prompt, nao o modelo',
    );
    continue;
  }

  if (!segunda.texto.trim()) {
    console.log(`modelo ${modelo}: NAO devolveu nada em nenhum dos dois prompts -- a imagem nao chega ao modelo`);
    continue;
  }

  console.log(
    `modelo ${modelo}: NAO acha o codigo em nenhum dos dois prompts`
      + ` -- com o prompt neutro respondeu: ${resumir(segunda.texto)}`,
  );
}
