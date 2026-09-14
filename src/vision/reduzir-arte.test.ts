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

  it('devolve o que recebeu quando não consegue decodificar a imagem', async () => {
    const nadaDeImagem = Buffer.from('isto não é uma imagem');

    const arte = await reduzirArteParaLeitura(nadaDeImagem);

    expect(arte.reduzida).toBe(false);
    expect(arte.imagem).toBe(nadaDeImagem);
  });
});
