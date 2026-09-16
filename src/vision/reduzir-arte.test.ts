import { describe, expect, it } from 'vitest';
import { createCanvas, loadImage } from '@napi-rs/canvas';

import { MAIOR_LADO_PARA_LEITURA, reduzirArteParaLeitura } from './reduzir-arte';

function arteDe(largura: number, altura: number): Buffer {
  const canvas = createCanvas(largura, altura);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#7fc4d4';
  ctx.fillRect(0, 0, largura, altura);
  ctx.fillStyle = '#f2d35a';
  ctx.font = `${Math.round(altura / 8)}px sans-serif`;
  ctx.fillText('VENHA SELEBRAR', Math.round(largura / 20), Math.round(altura / 2));
  return canvas.toBuffer('image/jpeg', 90);
}

describe('reduzirArteParaLeitura', () => {
  it('reduz a arte que passa do teto, mantendo a proporção', async () => {
    const arte = await reduzirArteParaLeitura(arteDe(2000, 1600));

    expect(arte.reduzida).toBe(true);
    expect(arte.largura).toBe(MAIOR_LADO_PARA_LEITURA);
    expect(arte.altura).toBe(Math.round((MAIOR_LADO_PARA_LEITURA * 1600) / 2000));

    const conferida = await loadImage(arte.imagem);
    expect(conferida.width).toBe(arte.largura);
    expect(conferida.height).toBe(arte.altura);
  });

  it('reduz pelo maior lado quando a arte é mais alta que larga', async () => {
    const arte = await reduzirArteParaLeitura(arteDe(1000, 2500));

    expect(arte.altura).toBe(MAIOR_LADO_PARA_LEITURA);
    expect(arte.largura).toBe(Math.round((MAIOR_LADO_PARA_LEITURA * 1000) / 2500));
  });

  it('devolve os mesmos bytes quando a arte já cabe no teto', async () => {
    const original = arteDe(900, 1100);

    const arte = await reduzirArteParaLeitura(original);

    expect(arte.reduzida).toBe(false);
    expect(arte.imagem).toBe(original);
    expect(arte.largura).toBe(900);
    expect(arte.altura).toBe(1100);
  });

  it('respeita o teto pedido em vez do padrão', async () => {
    const arte = await reduzirArteParaLeitura(arteDe(2000, 1600), 600);

    expect(arte.largura).toBe(600);
  });

  // Cada arte sobe duas vezes ao provedor, na primeira passagem e na
  // conferência. Numa peça fotográfica o PNG pesa cinco vezes e meia o JPEG, e
  // o que ele preserva sem perdas é o ruído de uma foto que já era JPEG antes.
  it('manda a peça fotográfica em JPEG, que é onde ela fica menor', async () => {
    const foto = createCanvas(2000, 1600);
    const ctx = foto.getContext('2d');
    for (let x = 0; x < 2000; x += 2) {
      for (let y = 0; y < 1600; y += 2) {
        ctx.fillStyle = `rgb(${(x * 7) % 256},${(y * 13) % 256},${(x * y) % 256})`;
        ctx.fillRect(x, y, 2, 2);
      }
    }

    const arte = await reduzirArteParaLeitura(foto.toBuffer('image/jpeg', 90));

    expect(arte.mime).toBe('image/jpeg');
    expect(await loadImage(arte.imagem)).toBeTruthy();
  });

  it('mantém em PNG a peça chapada, onde o PNG já é o menor', async () => {
    const chapada = createCanvas(2000, 1600);
    const ctx = chapada.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, 2000, 1600);
    ctx.fillStyle = '#101010';
    ctx.font = '160px sans-serif';
    ctx.fillText('VENHA SELEBRAR', 60, 800);

    const arte = await reduzirArteParaLeitura(chapada.toBuffer('image/png'));

    expect(arte.mime).toBe('image/png');
  });

  it('não declara formato para a arte que segue como veio', async () => {
    const arte = await reduzirArteParaLeitura(arteDe(900, 1100));

    expect(arte.reduzida).toBe(false);
    expect(arte.mime).toBe('');
  });

  it('devolve o que recebeu quando não consegue decodificar a imagem', async () => {
    const nadaDeImagem = Buffer.from('isto não é uma imagem');

    const arte = await reduzirArteParaLeitura(nadaDeImagem);

    expect(arte.reduzida).toBe(false);
    expect(arte.imagem).toBe(nadaDeImagem);
  });
});
