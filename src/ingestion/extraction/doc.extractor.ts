import { MalformedDocumentError, ProtectedDocumentError, ExtractedPage } from './extracted-text';

interface WordDocument {
  getBody(): string;
  getFootnotes(): string;
  getEndnotes(): string;
  getTextboxes(): string;
}

interface CfbEntry {
  content: Uint8Array | number[];
}

interface CfbModule {
  read(data: Buffer, options: { type: 'buffer' }): unknown;
  find(container: unknown, path: string): CfbEntry | null;
}

const WORD_MAGIC = 0xa5ec;
const FIB_FLAG_ENCRYPTED = 0x0100;
const BULLET_START = /^([•◦▪·‣o*-]|\d+[.)])\t/;

/**
 * Recusa um `.doc` cifrado antes de tentar interpretá-lo.
 *
 * O bit `fEncrypted` do FIB é a única forma barata de distinguir "protegido por
 * senha" de "corrompido": sem essa checagem o parser falha com erro de leitura
 * de faixa e a tela mostraria "arquivo ilegível" para um arquivo íntegro que só
 * precisa ser reenviado aberto.
 */
function assertNotEncrypted(content: Buffer): void {
  const CFB = require('cfb') as CfbModule;

  let stream: CfbEntry | null = null;
  try {
    const container = CFB.read(content, { type: 'buffer' });
    stream = CFB.find(container, 'WordDocument');
  } catch {
    return;
  }

  if (!stream) return;

  const fib = Buffer.from(stream.content as Uint8Array);
  if (fib.length < 12) return;
  if (fib.readUInt16LE(0) !== WORD_MAGIC) return;

  if ((fib.readUInt16LE(10) & FIB_FLAG_ENCRYPTED) !== 0) {
    throw new ProtectedDocumentError('.doc cifrado (fEncrypted)');
  }
}

/**
 * As linhas de um corpo de `.doc` em formato aproveitável para o chunker.
 *
 * O parser devolve célula de tabela separada por tabulação e item de lista como
 * `\t•\tTexto`. A tabulação não sobrevive à normalização — ela virou espaço —,
 * então a fronteira de célula é convertida para ` | `, o mesmo separador que o
 * extrator de planilha usa, e a tabulação decorativa do marcador de lista vira
 * um espaço simples.
 */
export function readableDocLines(body: string): string {
  return String(body || '')
    .split('\n')
    .map((line) => {
      const trimmed = line.replace(/\t+$/, '').replace(/^\t+/, '');
      const unbulleted = trimmed.replace(BULLET_START, '$1 ');
      return unbulleted.replace(/\t+/g, ' | ');
    })
    .join('\n');
}

/**
 * O texto de um `.doc` binário (Word 97-2003), como uma página só.
 *
 * O formato não carrega paginação — a quebra de página é decidida na
 * renderização —, então `pageNumber` é nulo, como no DOCX.
 *
 * A leitura é puramente estrutural e em memória: nada de macro executada, de
 * objeto incorporado interpretado ou de arquivo temporário em disco.
 *
 * Lança `ProtectedDocumentError` para arquivo cifrado e `MalformedDocumentError`
 * para arquivo truncado ou que não é um `.doc`.
 */
export async function extractDoc(content: Buffer): Promise<ExtractedPage[]> {
  assertNotEncrypted(content);

  const WordExtractor = require('word-extractor') as new () => {
    extract(input: Buffer): Promise<WordDocument>;
  };

  let document: WordDocument;
  try {
    document = await new WordExtractor().extract(content);
  } catch (error) {
    throw new MalformedDocumentError(
      `.doc não pôde ser interpretado: ${error instanceof Error ? error.message : error}`,
    );
  }

  const sections = [
    document.getBody(),
    document.getTextboxes(),
    document.getFootnotes(),
    document.getEndnotes(),
  ];

  const text = sections
    .map((section) => readableDocLines(section))
    .map((section) => section.trim())
    .filter((section) => section.length > 0)
    .join('\n\n');

  return [{ pageNumber: null, text }];
}
