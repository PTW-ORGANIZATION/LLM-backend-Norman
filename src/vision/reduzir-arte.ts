/**
 * O maior lado, em pixels, com que uma arte chega ao modelo de visão.
 *
 * O modelo fatia a imagem em blocos, e o custo cresce com a área: a mesma arte
 * a 900x1100 é transcrita em 6 segundos e a 2000x1600 estoura os 180 segundos
 * que o chamador espera — o que na tela vira revisão nenhuma. Neste teto o
 * título, o texto miúdo e a data continuam legíveis.
 */
export const MAIOR_LADO_PARA_LEITURA = 1200;

const QUALIDADE_JPEG = 90;

export type ArteParaLeitura = {
  imagem: Buffer;
  largura: number;
  altura: number;
  reduzida: boolean;
};

type ModuloDeCanvas = {
  loadImage: (fonte: Buffer) => Promise<{ width: number; height: number }>;
  createCanvas: (largura: number, altura: number) => {
    getContext: (tipo: '2d') => { drawImage: (imagem: unknown, x: number, y: number, largura: number, altura: number) => void };
    toBuffer: (mime: 'image/jpeg', qualidade: number) => Buffer;
  };
};

/**
 * A arte no tamanho em que o modelo de visão consegue lê-la a tempo.
 *
 * Devolve a imagem original, sem reencodar, quando ela já cabe no teto. Uma
 * imagem que a biblioteca não consegue decodificar também volta como veio: a
 * leitura é quem decide o que fazer com ela, e reduzir é otimização, não
 * validação.
 *
 * @param imagem os bytes da arte
 * @param maiorLado o teto para o maior lado, em pixels
 * @returns a imagem a enviar, suas dimensões e se houve redução
 */
export async function reduzirArteParaLeitura(
  imagem: Buffer,
  maiorLado: number = MAIOR_LADO_PARA_LEITURA,
): Promise<ArteParaLeitura> {
  const canvas = require('@napi-rs/canvas') as ModuloDeCanvas;

  let original: { width: number; height: number };
  try {
    original = await canvas.loadImage(imagem);
  } catch {
    return { imagem, largura: 0, altura: 0, reduzida: false };
  }

  const maiorLadoOriginal = Math.max(original.width, original.height);
  if (maiorLadoOriginal <= maiorLado) {
    return { imagem, largura: original.width, altura: original.height, reduzida: false };
  }

  const escala = maiorLado / maiorLadoOriginal;
  const largura = Math.max(1, Math.round(original.width * escala));
  const altura = Math.max(1, Math.round(original.height * escala));

  const destino = canvas.createCanvas(largura, altura);
  destino.getContext('2d').drawImage(original, 0, 0, largura, altura);

  return { imagem: destino.toBuffer('image/jpeg', QUALIDADE_JPEG), largura, altura, reduzida: true };
}
