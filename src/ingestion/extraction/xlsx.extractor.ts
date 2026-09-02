import { ExtractedPage } from './extracted-text';

interface ExcelCell {
  text?: string;
  value?: unknown;
}

interface ExcelRow {
  eachCell(options: { includeEmpty: boolean }, callback: (cell: ExcelCell) => void): void;
}

interface ExcelWorksheet {
  name?: string;
  eachRow(options: { includeEmpty: boolean }, callback: (row: ExcelRow) => void): void;
}

interface ExcelWorkbook {
  worksheets: ExcelWorksheet[];
  xlsx: { load(data: Buffer): Promise<unknown> };
}

function cellToText(cell: ExcelCell): string {
  const value = cell.value;
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);

  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (typeof record.text === 'string') return record.text;
    if (Array.isArray(record.richText)) {
      return record.richText.map((part) => String((part as { text?: string }).text ?? '')).join('');
    }
    if (record.result !== undefined && record.result !== null) return String(record.result);
    if (typeof record.hyperlink === 'string') return record.hyperlink;
    return typeof cell.text === 'string' ? cell.text : '';
  }

  return String(value);
}

/**
 * Uma planilha por página: `pageNumber` é o índice da aba, 1-based.
 *
 * A aba é a unidade de citação de um XLSX — é o que permite a resposta apontar
 * de onde o número saiu. Cada linha vira uma linha de texto com as células
 * separadas por ` | `, e linha inteiramente vazia é descartada.
 */
export async function extractXlsx(content: Buffer): Promise<ExtractedPage[]> {
  const ExcelJS = require('exceljs') as { Workbook: new () => ExcelWorkbook };
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(content);

  return workbook.worksheets.map((worksheet, index) => {
    const lines: string[] = [];
    worksheet.eachRow({ includeEmpty: false }, (row) => {
      const cells: string[] = [];
      row.eachCell({ includeEmpty: true }, (cell) => {
        cells.push(cellToText(cell).trim());
      });
      while (cells.length > 0 && cells[cells.length - 1] === '') cells.pop();
      if (cells.some((cell) => cell.length > 0)) {
        lines.push(cells.join(' | '));
      }
    });

    const title = worksheet.name ? `# ${worksheet.name}` : '';
    const body = lines.join('\n');
    return {
      pageNumber: index + 1,
      text: title && body ? `${title}\n${body}` : body,
    };
  });
}
