/**
 * O maior lado, em pixels, com que uma arte chega ao modelo de visão.
 *
 * O modelo fatia a imagem em blocos, e o custo cresce com a área: a mesma arte
 * a 900x1100 é transcrita em 6 segundos e a 2000x1600 estoura os 180 segundos
 * que o chamador espera — o que na tela vira revisão nenhuma. Neste teto o
 * título, o texto miúdo e a data continuam legíveis.
 */
export const MAIOR_LADO_PARA_LEITURA = 1200;

export type ArteParaLeitura = {
  imagem: Buffer;
  largura: number;
  altura: number;
  reduzida: boolean;
  /** O tipo dos bytes em `imagem`. Sem redução, é desconhecido e vem vazio. */
  mime: string;
};

/**
 * A qualidade do JPEG quando ele é a codificação escolhida.
 *
 * Alta de propósito: quem vai ler estas letras é um modelo, e economizar aqui
 * é economizar na borda do glifo, que é onde a leitura se decide.
 */
const QUALIDADE_DO_JPEG = 92;

type ModuloDeCanvas = {
  loadImage: (fonte: Buffer) => Promise<{ width: number; height: number }>;
  createCanvas: (largura: number, altura: number) => {
    getContext: (tipo: '2d') => { drawImage: (imagem: unknown, x: number, y: number, largura: number, altura: number) => void };
    toBuffer: ((mime: 'image/png') => Buffer) & ((mime: 'image/jpeg', qualidade: number) => Buffer);
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
 * A saída sai na codificação que ficar menor, entre PNG e JPEG de qualidade
 * alta. Não há uma que sirva às duas artes que chegam aqui. Peça chapada —
 * fundo liso, texto vetorial — fica menor em PNG, e nela o PNG ainda é de
 * graça: preserva a borda do glifo sem custar bytes. Peça fotográfica é o
 * oposto, e por muito: uma arte real de 2000x1600 sai com 1105 KB em PNG e
 * 201 KB em JPEG — cinco vezes e meia de bytes subindo duas vezes por arte,
 * na primeira passagem e na conferência, para preservar sem perdas o ruído de
 * uma foto que já era JPEG antes de chegar aqui.
 *
 * Escolher pelo tamanho acerta os dois casos sem precisar adivinhar qual deles
 * é a arte da vez: onde o PNG serve, ele ganha sozinho.
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
    return { imagem, largura: 0, altura: 0, reduzida: false, mime: '' };
  }

  const maiorLadoOriginal = Math.max(original.width, original.height);
  if (maiorLadoOriginal <= maiorLado) {
    return { imagem, largura: original.width, altura: original.height, reduzida: false, mime: '' };
  }

  const escala = maiorLado / maiorLadoOriginal;
  const largura = Math.max(1, Math.round(original.width * escala));
  const altura = Math.max(1, Math.round(original.height * escala));

  const destino = canvas.createCanvas(largura, altura);
  destino.getContext('2d').drawImage(original, 0, 0, largura, altura);

  const png = destino.toBuffer('image/png');
  const jpeg = destino.toBuffer('image/jpeg', QUALIDADE_DO_JPEG);
  const menor = jpeg.length < png.length
    ? { imagem: jpeg, mime: 'image/jpeg' }
    : { imagem: png, mime: 'image/png' };

  return { ...menor, largura, altura, reduzida: true };
}
