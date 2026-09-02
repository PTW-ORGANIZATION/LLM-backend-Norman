import { ExtractedPage } from './extraction/extracted-text';

export interface TextChunk {
  chunkIndex: number;
  pageNumber: number | null;
  content: string;
}

export interface ChunkOptions {
  chunkSize: number;
  overlap: number;
}

const BREAK_CANDIDATES = ['\n\n', '\n', '. ', ' '];

function findBreak(window: string, minIndex: number): number {
  for (const separator of BREAK_CANDIDATES) {
    const index = window.lastIndexOf(separator);
    if (index >= minIndex) return index + separator.length;
  }
  return -1;
}

function splitText(text: string, chunkSize: number, overlap: number): string[] {
  if (text.length <= chunkSize) {
    const single = text.trim();
    return single.length > 0 ? [single] : [];
  }

  const parts: string[] = [];
  let start = 0;

  while (start < text.length) {
    let end = Math.min(start + chunkSize, text.length);

    if (end < text.length) {
      const breakAt = findBreak(text.slice(start, end), Math.floor(chunkSize / 2));
      if (breakAt > 0) end = start + breakAt;
    }

    const part = text.slice(start, end).trim();
    if (part.length > 0) parts.push(part);

    if (end >= text.length) break;
    start = Math.max(end - overlap, start + 1);
  }

  return parts;
}

/**
 * Os chunks de um documento já extraído, numerados em sequência única.
 *
 * Um chunk nunca atravessa a fronteira de página: é o que permite gravar
 * `page_number` exato e a resposta citar a página de onde o trecho saiu. A
 * consequência aceita é que página curta gera chunk curto.
 *
 * `overlap` é limitado a menos da metade de `chunkSize` — sobreposição maior que
 * o avanço faria o corte não progredir.
 */
export function chunkPages(pages: ExtractedPage[], options: ChunkOptions): TextChunk[] {
  const chunkSize = Math.max(1, options.chunkSize);
  const overlap = Math.min(Math.max(0, options.overlap), Math.floor(chunkSize / 2));

  const chunks: TextChunk[] = [];
  for (const page of pages) {
    for (const content of splitText(page.text, chunkSize, overlap)) {
      chunks.push({ chunkIndex: chunks.length, pageNumber: page.pageNumber, content });
    }
  }
  return chunks;
}
