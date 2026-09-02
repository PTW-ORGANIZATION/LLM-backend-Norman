import { ExtractedPage } from './extracted-text';

/**
 * O texto corrido de um DOCX, como uma página só.
 *
 * DOCX não tem paginação no arquivo — a quebra de página é decidida na hora de
 * renderizar —, então `pageNumber` é nulo em vez de um número inventado.
 */
export async function extractDocx(content: Buffer): Promise<ExtractedPage[]> {
  const mammoth = require('mammoth') as {
    extractRawText(input: { buffer: Buffer }): Promise<{ value: string }>;
  };
  const result = await mammoth.extractRawText({ buffer: content });
  return [{ pageNumber: null, text: result.value ?? '' }];
}
