import { ExtractedPage, MalformedDocumentError } from './extracted-text';
import { BiffCell, readBiffWorkbook } from './xls-biff';

interface CfbEntry {
  content: Uint8Array | number[];
}

interface CfbModule {
  read(data: Buffer, options: { type: 'buffer' }): unknown;
  find(container: unknown, path: string): CfbEntry | null;
}

const WORKBOOK_STREAM_NAMES = ['Workbook', 'Book'];

function readWorkbookStream(content: Buffer): Buffer {
  const CFB = require('cfb') as CfbModule;

  let container: unknown;
  try {
    container = CFB.read(content, { type: 'buffer' });
  } catch (error) {
    throw new MalformedDocumentError(
      `.xls não é um arquivo OLE válido: ${error instanceof Error ? error.message : error}`,
    );
  }

  for (const name of WORKBOOK_STREAM_NAMES) {
    const entry = CFB.find(container, name);
    if (entry) return Buffer.from(entry.content as Uint8Array);
  }

  throw new MalformedDocumentError('.xls sem stream Workbook');
}

/**
 * As linhas de texto de uma planilha, com as células na coluna original.
 *
 * A célula vazia entra como campo vazio em vez de ser omitida, para que o valor
 * continue debaixo do rótulo certo quando a planilha tem buraco no meio ou faixa
 * mesclada. Linha inteiramente vazia é descartada, como no XLSX.
 */
export function layoutSheetRows(cells: BiffCell[]): string[] {
  if (cells.length === 0) return [];

  const rows = new Map<number, string[]>();
  for (const cell of cells) {
    const row = rows.get(cell.row) ?? [];
    row[cell.column] = cell.text;
    rows.set(cell.row, row);
  }

  return [...rows.keys()]
    .sort((left, right) => left - right)
    .map((rowIndex) => {
      const row = rows.get(rowIndex) as string[];
      const filled = Array.from(row, (value) => (value ?? '').trim());
      while (filled.length > 0 && filled[filled.length - 1] === '') filled.pop();
      return filled.join(' | ');
    })
    .filter((line) => line.replace(/[ |]/g, '').length > 0);
}

/**
 * Uma planilha por página de um `.xls` binário (Excel 97-2003): `pageNumber` é o
 * índice da aba, 1-based, como no XLSX.
 *
 * A leitura é estrutural e em memória — os registros de macro do arquivo nunca
 * são interpretados, apenas ignorados.
 *
 * Lança `ProtectedDocumentError` para arquivo cifrado e `MalformedDocumentError`
 * para arquivo corrompido ou de versão anterior ao Excel 97.
 */
export async function extractXls(content: Buffer, maxSheets: number): Promise<ExtractedPage[]> {
  const stream = readWorkbookStream(content);
  const sheets = readBiffWorkbook(stream, maxSheets);

  return sheets.map((sheet, index) => {
    const body = layoutSheetRows(sheet.cells).join('\n');
    const title = sheet.name ? `# ${sheet.name}` : '';
    return {
      pageNumber: index + 1,
      text: title && body ? `${title}\n${body}` : body,
    };
  });
}
