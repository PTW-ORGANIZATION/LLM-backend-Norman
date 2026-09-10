import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { PptxReader, resolvePartPath } from './pptx.extractor';
import {
  DocumentTooLargeError,
  MalformedDocumentError,
  ProtectedDocumentError,
} from './extracted-text';

const FIXTURE = path.join(__dirname, '__fixtures__', 'apresentacao.pptx');

function realPptx(): Buffer {
  return fs.readFileSync(FIXTURE);
}

async function slidesOf(content: Buffer, maxSlides = 300) {
  const reader = await PptxReader.open(content);
  return reader.slides(maxSlides);
}

describe('resolvePartPath', () => {
  it('resolve alvo relativo à pasta da parte que o declara', () => {
    expect(resolvePartPath('ppt/slides', '../notesSlides/notesSlide1.xml')).toBe(
      'ppt/notesSlides/notesSlide1.xml',
    );
    expect(resolvePartPath('ppt/slides', '../media/image1.png')).toBe('ppt/media/image1.png');
  });

  it('resolve alvo na mesma pasta', () => {
    expect(resolvePartPath('ppt', 'slides/slide1.xml')).toBe('ppt/slides/slide1.xml');
  });

  it('aceita alvo absoluto do pacote', () => {
    expect(resolvePartPath('ppt/slides', '/ppt/media/image1.png')).toBe('ppt/media/image1.png');
  });
});

describe('PptxReader — apresentação real', () => {
  it('produz uma unidade por slide, numerada na ordem da apresentação', async () => {
    const slides = await slidesOf(realPptx());

    expect(slides).toHaveLength(4);
    expect(slides.map((slide) => slide.slideNumber)).toEqual([1, 2, 3, 4]);
  });

  it('abre o slide pelo título e mantém o corpo em seguida', async () => {
    const [primeiro] = await slidesOf(realPptx());

    expect(primeiro.text.startsWith('Campanha Verao 2026')).toBe(true);
    expect(primeiro.text).toContain('Praca principal: litoral norte');
    expect(primeiro.text).toContain('Verba aprovada: 480 mil');
    expect(primeiro.text.indexOf('Campanha Verao 2026')).toBeLessThan(
      primeiro.text.indexOf('Praca principal'),
    );
  });

  it('extrai as notas do apresentador', async () => {
    const [primeiro] = await slidesOf(realPptx());

    expect(primeiro.text).toContain('Notas do apresentador:');
    expect(primeiro.text).toContain('ORQUIDEA CROMADA 47');
  });

  it('extrai tabela com as células separadas', async () => {
    const slides = await slidesOf(realPptx());
    const tabela = slides[1];

    expect(tabela.text).toContain('Divisao por canal');
    expect(tabela.text).toContain('Canal | Participacao');
    expect(tabela.text).toContain('Digital | 62 por cento');
    expect(tabela.text).toContain('Radio | 38 por cento');
  });

  it('extrai os rótulos textuais do gráfico', async () => {
    const slides = await slidesOf(realPptx());
    const grafico = slides[2];

    expect(grafico.text).toContain('Investimento por praca');
    expect(grafico.text).toContain('Verba 2026');
    expect(grafico.text).toContain('Litoral Norte');
    expect(grafico.text).toContain('Serra Gaucha');
  });

  it('aponta a imagem do slide sem texto, para o OCR decidir depois', async () => {
    const slides = await slidesOf(realPptx());
    const somenteImagem = slides[3];

    expect(somenteImagem.text).toBe('');
    expect(somenteImagem.imageParts).toEqual(['ppt/media/image1.png']);
  });

  it('devolve os bytes de uma parte de imagem', async () => {
    const reader = await PptxReader.open(realPptx());
    const image = await reader.readImagePart('ppt/media/image1.png');

    expect(image).not.toBeNull();
    expect((image as Buffer).subarray(1, 4).toString('latin1')).toBe('PNG');
  });

  it('devolve nulo para parte de imagem inexistente', async () => {
    const reader = await PptxReader.open(realPptx());
    expect(await reader.readImagePart('ppt/media/naoexiste.png')).toBeNull();
  });

  it('respeita o teto de slides', async () => {
    const slides = await slidesOf(realPptx(), 2);
    expect(slides).toHaveLength(2);
  });

  it('não repete número de página entre slides', async () => {
    const slides = await slidesOf(realPptx());
    const numeros = slides.map((slide) => slide.slideNumber);
    expect(new Set(numeros).size).toBe(numeros.length);
  });
});

describe('PptxReader — arquivo inválido', () => {
  it('recusa pacote cifrado, que vem como OLE em vez de zip', async () => {
    const ole = Buffer.concat([
      Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
      Buffer.alloc(512),
    ]);
    await expect(PptxReader.open(ole)).rejects.toBeInstanceOf(ProtectedDocumentError);
  });

  it('recusa arquivo que não é um zip', async () => {
    await expect(PptxReader.open(Buffer.from('isto nao e um pptx'))).rejects.toBeInstanceOf(
      MalformedDocumentError,
    );
  });

  it('recusa arquivo vazio', async () => {
    await expect(PptxReader.open(Buffer.alloc(0))).rejects.toBeInstanceOf(MalformedDocumentError);
  });

  it('recusa zip válido sem nenhum slide', async () => {
    const JSZip = (await import('jszip')).default;
    const zip = new JSZip();
    zip.file('docProps/app.xml', '<Properties/>');
    const semSlides = await zip.generateAsync({ type: 'nodebuffer' });

    await expect(slidesOf(semSlides)).rejects.toThrow(/sem nenhum slide/);
  });

  it('recusa pacote que ultrapassa o teto depois de descompactado', async () => {
    const JSZip = (await import('jszip')).default;
    const zip = new JSZip();
    zip.file('ppt/slides/slide1.xml', '<p:sld/>');
    zip.file('ppt/media/grande.txt', 'a'.repeat(4096));
    const compressed = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });

    await expect(PptxReader.open(compressed, 1024)).rejects.toBeInstanceOf(
      DocumentTooLargeError,
    );
  });

  it('recusa slide com XML quebrado', async () => {
    const JSZip = (await import('jszip')).default;
    const zip = new JSZip();
    zip.file('ppt/slides/slide1.xml', '<p:sld><p:cSld><p:spTree>');
    const quebrado = await zip.generateAsync({ type: 'nodebuffer' });

    await expect(slidesOf(quebrado)).rejects.toBeInstanceOf(MalformedDocumentError);
  });
});
