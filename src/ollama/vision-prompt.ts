/**
 * O que se pede ao modelo de visão, e como reconhecer "não há texto aqui".
 *
 * Mora fora do serviço para o diagnóstico do deploy exercitar o prompt de
 * verdade em vez de uma cópia. A cópia custou caro: o prompt anterior
 * terminava oferecendo ao modelo uma saída de uma palavra, e o minicpm-v
 * passou a tomá-la para toda imagem — inclusive as legíveis. Da tela isso
 * parecia cegueira do modelo, e não era: ele lia a imagem e desistia de
 * transcrever, porque desistir saía mais barato.
 *
 * Por isso a ordem das frases aqui não é enfeite. O pedido vem primeiro e no
 * imperativo; a saída vem por último, condicionada, e custa uma frase inteira
 * em vez de uma palavra.
 */

/** A frase que o modelo devolve quando a imagem não tem palavra nenhuma. */
export const SEM_TEXTO_SENTINELA = 'IMAGEM SEM PALAVRAS ESCRITAS';

export const TRANSCRIPTION_PROMPT = [
  'Escreva o que está escrito nesta imagem.',
  'Copie as palavras exatamente como aparecem, na ordem em que aparecem.',
  'Não descreva a imagem, não traduza e não comente.',
  `Só se não houver nenhuma palavra escrita, responda ${SEM_TEXTO_SENTINELA}.`,
].join(' ');

/**
 * O modelo raramente devolve a sentinela ao pé da letra: troca a ordem, põe
 * ponto, acentua, enfeita com negrito. Reconhecer só a forma exata deixaria
 * imagem sem texto virar conhecimento vazio, que é justamente o que a
 * sentinela existe para impedir.
 */
const FORMAS_DE_AUSENCIA = [
  /imagem\s+sem\s+palavras?\s+escritas?/i,
  /sem\s+palavras?\s+escritas?\s+na\s+imagem/i,
  /n[ãa]o\s+h[áa]\s+(?:nenhuma\s+)?palavras?\s+escritas?/i,
  /n[ãa]o\s+(?:h[áa]|existe|cont[ée]m|tem)\s+(?:nenhum\s+)?texto/i,
  // O marcador do prompt antigo. Modelo com resposta em cache e imagem
  // reprocessada ainda o devolvem; reconhecê-lo não custa nada.
  /nenhum_texto/i,
];

export function declarouAusenciaDeTexto(bruto: string): boolean {
  return FORMAS_DE_AUSENCIA.some((forma) => forma.test(String(bruto || '')));
}

export function removerSentinela(bruto: string): string {
  return FORMAS_DE_AUSENCIA.reduce(
    (texto, forma) => texto.replace(new RegExp(forma.source, 'gi'), ''),
    String(bruto || ''),
  );
}
