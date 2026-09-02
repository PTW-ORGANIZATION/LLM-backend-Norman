import { describe, expect, it } from 'vitest';
import { chunkPages } from './chunking';

const OPTIONS = { chunkSize: 100, overlap: 20 };

describe('chunkPages', () => {
  it('numera os chunks em sequência única através das páginas', () => {
    const chunks = chunkPages(
      [
        { pageNumber: 1, text: 'a'.repeat(250) },
        { pageNumber: 2, text: 'b'.repeat(250) },
      ],
      OPTIONS,
    );

    expect(chunks.map((chunk) => chunk.chunkIndex)).toEqual(
      chunks.map((_, index) => index),
    );
  });

  it('nunca mistura páginas dentro de um chunk', () => {
    const chunks = chunkPages(
      [
        { pageNumber: 1, text: 'pagina um '.repeat(40) },
        { pageNumber: 2, text: 'pagina dois '.repeat(40) },
      ],
      OPTIONS,
    );

    for (const chunk of chunks) {
      const mentionsOne = chunk.content.includes('pagina um');
      const mentionsTwo = chunk.content.includes('pagina dois');
      expect(mentionsOne && mentionsTwo).toBe(false);
    }
  });

  it('preserva o número da página em cada chunk', () => {
    const chunks = chunkPages(
      [
        { pageNumber: 7, text: 'x'.repeat(300) },
        { pageNumber: null, text: 'y'.repeat(50) },
      ],
      OPTIONS,
    );

    expect(chunks.filter((c) => c.content.startsWith('x')).every((c) => c.pageNumber === 7)).toBe(
      true,
    );
    expect(chunks.filter((c) => c.content.startsWith('y')).every((c) => c.pageNumber === null)).toBe(
      true,
    );
  });

  it('respeita o tamanho máximo do chunk', () => {
    const chunks = chunkPages([{ pageNumber: 1, text: 'palavra '.repeat(200) }], OPTIONS);
    for (const chunk of chunks) {
      expect(chunk.content.length).toBeLessThanOrEqual(OPTIONS.chunkSize);
    }
  });

  it('devolve um chunk só quando a página cabe inteira', () => {
    const chunks = chunkPages([{ pageNumber: 1, text: 'curto' }], OPTIONS);
    expect(chunks).toEqual([{ chunkIndex: 0, pageNumber: 1, content: 'curto' }]);
  });

  it('corta em fronteira de parágrafo quando existe uma', () => {
    const text = `${'a'.repeat(60)}\n\n${'b'.repeat(60)}`;
    const chunks = chunkPages([{ pageNumber: 1, text }], OPTIONS);
    expect(chunks[0].content).toBe('a'.repeat(60));
  });

  it('progride mesmo com sobreposição maior que o avanço', () => {
    const chunks = chunkPages([{ pageNumber: 1, text: 'z'.repeat(1000) }], {
      chunkSize: 50,
      overlap: 999,
    });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.length).toBeLessThan(200);
  });

  it('não gera chunk para página vazia', () => {
    expect(chunkPages([{ pageNumber: 1, text: '' }], OPTIONS)).toEqual([]);
  });
});
