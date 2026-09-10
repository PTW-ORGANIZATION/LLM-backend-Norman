import { MalformedDocumentError, ProtectedDocumentError } from './extracted-text';

const RECORD = {
  FORMULA: 0x0006,
  EOF: 0x000a,
  PROTECT: 0x0012,
  DATEMODE: 0x0022,
  FILEPASS: 0x002f,
  CONTINUE: 0x003c,
  BOUNDSHEET: 0x0085,
  MULRK: 0x00bd,
  MULBLANK: 0x00be,
  XF: 0x00e0,
  SST: 0x00fc,
  LABELSST: 0x00fd,
  BLANK: 0x0201,
  NUMBER: 0x0203,
  LABEL: 0x0204,
  BOOLERR: 0x0205,
  STRING: 0x0207,
  RK: 0x027e,
  FORMAT: 0x041e,
  BOF: 0x0809,
} as const;

const BIFF8_VERSION = 0x0600;
const SUBSTREAM_GLOBALS = 0x0005;
const SUBSTREAM_WORKSHEET = 0x0010;
const FORMULA_RESULT_IS_SPECIAL = 0xffff;

const BUILTIN_DATE_FORMATS = new Set([
  14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51,
  52, 53, 54, 55, 56, 57, 58,
]);

interface BiffRecord {
  id: number;
  data: Buffer;
}

export interface BiffCell {
  row: number;
  column: number;
  text: string;
}

export interface BiffSheet {
  name: string;
  cells: BiffCell[];
}

/**
 * Os registros de um substream BIFF a partir de uma posição, até o `EOF` dele.
 *
 * Para no primeiro registro de id zero porque o stream do CFB vem preenchido até
 * o fim do setor: o que sobra depois do último `EOF` é enchimento, não registro.
 */
function readRecords(stream: Buffer, start: number): BiffRecord[] {
  const records: BiffRecord[] = [];
  let position = start;

  while (position + 4 <= stream.length) {
    const id = stream.readUInt16LE(position);
    const length = stream.readUInt16LE(position + 2);
    if (id === 0 && length === 0) break;
    if (position + 4 + length > stream.length) {
      throw new MalformedDocumentError('registro BIFF truncado no fim do stream');
    }

    const data = stream.subarray(position + 4, position + 4 + length);
    position += 4 + length;
    records.push({ id, data });

    if (id === RECORD.EOF) break;
  }

  return records;
}

/**
 * Lê a cadeia `SST` + `CONTINUE` como um fluxo único de caracteres.
 *
 * Uma string da tabela pode ser cortada no meio por um `CONTINUE`, e o primeiro
 * byte do registro seguinte não é caractere: é um novo bit de compressão válido
 * só para o resto daquela string. Ignorar essa regra é o que faz um leitor
 * ingênuo devolver texto embaralhado a partir da primeira planilha grande.
 */
class SharedStringReader {
  private segment = 0;
  private offset = 0;

  constructor(private readonly segments: Buffer[]) {}

  private get current(): Buffer {
    return this.segments[this.segment] ?? Buffer.alloc(0);
  }

  private remaining(): number {
    return this.current.length - this.offset;
  }

  private advanceSegment(): boolean {
    if (this.segment + 1 >= this.segments.length) return false;
    this.segment += 1;
    this.offset = 0;
    return true;
  }

  private ensure(bytes: number): void {
    if (this.remaining() >= bytes) return;
    if (!this.advanceSegment()) {
      throw new MalformedDocumentError('tabela de strings do XLS terminou no meio de um registro');
    }
  }

  private readUInt8(): number {
    this.ensure(1);
    const value = this.current.readUInt8(this.offset);
    this.offset += 1;
    return value;
  }

  private readUInt16(): number {
    this.ensure(2);
    const value = this.current.readUInt16LE(this.offset);
    this.offset += 2;
    return value;
  }

  private readUInt32(): number {
    this.ensure(4);
    const value = this.current.readUInt32LE(this.offset);
    this.offset += 4;
    return value;
  }

  private skip(bytes: number): void {
    let left = bytes;
    while (left > 0) {
      if (this.remaining() === 0 && !this.advanceSegment()) return;
      const step = Math.min(left, this.remaining());
      this.offset += step;
      left -= step;
    }
  }

  private readCharacters(count: number, highByteFlag: boolean): string {
    let wide = highByteFlag;
    const parts: string[] = [];
    let left = count;

    while (left > 0) {
      if (this.remaining() === 0) {
        if (!this.advanceSegment()) {
          throw new MalformedDocumentError('string do XLS cortada sem continuação');
        }
        wide = (this.readUInt8() & 0x01) !== 0;
      }

      const width = wide ? 2 : 1;
      const available = Math.floor(this.remaining() / width);
      if (available === 0) {
        this.skip(this.remaining());
        continue;
      }

      const take = Math.min(left, available);
      const bytes = this.current.subarray(this.offset, this.offset + take * width);
      parts.push(bytes.toString(wide ? 'utf16le' : 'latin1'));
      this.offset += take * width;
      left -= take;
    }

    return parts.join('');
  }

  readString(): string {
    if (this.remaining() < 3) {
      if (!this.advanceSegment()) return '';
    }

    const characterCount = this.readUInt16();
    const flags = this.readUInt8();
    const highByte = (flags & 0x01) !== 0;
    const hasRichRuns = (flags & 0x08) !== 0;
    const hasPhonetic = (flags & 0x04) !== 0;

    const runCount = hasRichRuns ? this.readUInt16() : 0;
    const phoneticBytes = hasPhonetic ? this.readUInt32() : 0;

    const text = this.readCharacters(characterCount, highByte);

    this.skip(runCount * 4);
    this.skip(phoneticBytes);

    return text;
  }
}

function readSharedStrings(records: BiffRecord[], sstIndex: number): string[] {
  const segments = [records[sstIndex].data];
  for (let index = sstIndex + 1; index < records.length; index += 1) {
    if (records[index].id !== RECORD.CONTINUE) break;
    segments.push(records[index].data);
  }

  const header = segments[0];
  if (header.length < 8) return [];

  const uniqueCount = header.readUInt32LE(4);
  const reader = new SharedStringReader(segments.map((segment, index) => (index === 0 ? segment.subarray(8) : segment)));

  const strings: string[] = [];
  for (let index = 0; index < uniqueCount; index += 1) {
    strings.push(reader.readString());
  }
  return strings;
}

/** Uma `XLUnicodeString` curta de registro BIFF8: contagem em 16 bits e bit de compressão. */
function readInlineString(data: Buffer, offset: number): string {
  if (offset + 3 > data.length) return '';
  const characterCount = data.readUInt16LE(offset);
  const wide = (data.readUInt8(offset + 2) & 0x01) !== 0;
  const start = offset + 3;
  const end = start + characterCount * (wide ? 2 : 1);
  return data.subarray(start, Math.min(end, data.length)).toString(wide ? 'utf16le' : 'latin1');
}

/**
 * O número guardado num campo `RK`, que embute um inteiro de 30 bits ou os bits
 * altos de um double para economizar quatro bytes por célula.
 */
export function decodeRkNumber(raw: number): number {
  const isInteger = (raw & 0x02) !== 0;
  const dividedByHundred = (raw & 0x01) !== 0;

  let value: number;
  if (isInteger) {
    value = raw >> 2;
  } else {
    const buffer = Buffer.alloc(8);
    buffer.writeInt32LE(raw & ~0x03, 4);
    value = buffer.readDoubleLE(0);
  }

  return dividedByHundred ? value / 100 : value;
}

/**
 * Se um código de formato numérico representa data ou hora.
 *
 * Descarta literal entre aspas e bloco entre colchetes antes de procurar os
 * marcadores de data, senão um formato de moeda como `"R$"#,##0.00` seria lido
 * como data por causa da letra dentro do literal.
 */
export function isDateFormat(formatIndex: number, formatCode: string | undefined): boolean {
  if (formatCode === undefined) return BUILTIN_DATE_FORMATS.has(formatIndex);

  const withoutLiterals = formatCode
    .replace(/"[^"]*"/g, '')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/\\./g, '');

  if (/[ymdYMD]/.test(withoutLiterals)) return true;
  if (/h/i.test(withoutLiterals)) return true;
  return BUILTIN_DATE_FORMATS.has(formatIndex);
}

function hasTimeTokens(formatCode: string | undefined): boolean {
  if (!formatCode) return false;
  const withoutLiterals = formatCode.replace(/"[^"]*"/g, '').replace(/\[[^\]]*\]/g, '');
  return /h/i.test(withoutLiterals);
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/**
 * O texto de um número que o formato da célula marca como data.
 *
 * Usa o mesmo `YYYY-MM-DD` que o extrator de XLSX, para que uma resposta não
 * mude de formato só porque o arquivo veio na versão antiga. Hora só aparece
 * quando o formato pede e a fração do dia não é zero.
 */
export function formatSerialDate(
  serial: number,
  use1904Epoch: boolean,
  formatCode: string | undefined,
): string {
  const wholeDays = Math.floor(serial);
  const dayFraction = serial - wholeDays;

  const epochUtc = use1904Epoch ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 31);
  const leapDayCorrection = !use1904Epoch && wholeDays >= 61 ? -1 : 0;
  const milliseconds = epochUtc + (wholeDays + leapDayCorrection) * 86400000;
  const date = new Date(milliseconds);

  const secondsOfDay = Math.round(dayFraction * 86400);
  const hours = Math.floor(secondsOfDay / 3600);
  const minutes = Math.floor((secondsOfDay % 3600) / 60);
  const seconds = secondsOfDay % 60;

  if (wholeDays === 0 && hasTimeTokens(formatCode)) {
    return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
  }

  const isoDate = date.toISOString().slice(0, 10);
  if (secondsOfDay > 0 && hasTimeTokens(formatCode)) {
    return `${isoDate} ${pad(hours)}:${pad(minutes)}`;
  }
  return isoDate;
}

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return '';
  if (Number.isInteger(value)) return String(value);
  return String(Number(value.toFixed(10)));
}

interface WorkbookFormats {
  use1904Epoch: boolean;
  formatCodeByXf: Map<number, string | undefined>;
  formatIndexByXf: Map<number, number>;
}

function readGlobals(records: BiffRecord[]): {
  sheets: Array<{ name: string; position: number }>;
  sharedStrings: string[];
  formats: WorkbookFormats;
} {
  const sheets: Array<{ name: string; position: number }> = [];
  const formatCodes = new Map<number, string>();
  const xfFormatIndexes: number[] = [];
  let sharedStrings: string[] = [];
  let use1904Epoch = false;

  records.forEach((record, index) => {
    switch (record.id) {
      case RECORD.FILEPASS:
        throw new ProtectedDocumentError('.xls cifrado (registro FILEPASS)');

      case RECORD.BOUNDSHEET: {
        const position = record.data.readUInt32LE(0);
        const characterCount = record.data.readUInt8(6);
        const wide = (record.data.readUInt8(7) & 0x01) !== 0;
        const end = 8 + characterCount * (wide ? 2 : 1);
        const name = record.data
          .subarray(8, Math.min(end, record.data.length))
          .toString(wide ? 'utf16le' : 'latin1');
        sheets.push({ name, position });
        break;
      }

      case RECORD.DATEMODE:
        use1904Epoch = record.data.readUInt16LE(0) === 1;
        break;

      case RECORD.FORMAT:
        formatCodes.set(record.data.readUInt16LE(0), readInlineString(record.data, 2));
        break;

      case RECORD.XF:
        xfFormatIndexes.push(record.data.readUInt16LE(2));
        break;

      case RECORD.SST:
        sharedStrings = readSharedStrings(records, index);
        break;

      default:
        break;
    }
  });

  const formatCodeByXf = new Map<number, string | undefined>();
  const formatIndexByXf = new Map<number, number>();
  xfFormatIndexes.forEach((formatIndex, xfIndex) => {
    formatIndexByXf.set(xfIndex, formatIndex);
    formatCodeByXf.set(xfIndex, formatCodes.get(formatIndex));
  });

  return { sheets, sharedStrings, formats: { use1904Epoch, formatCodeByXf, formatIndexByXf } };
}

function numericCellText(value: number, xfIndex: number, formats: WorkbookFormats): string {
  const formatIndex = formats.formatIndexByXf.get(xfIndex) ?? 0;
  const formatCode = formats.formatCodeByXf.get(xfIndex);

  if (isDateFormat(formatIndex, formatCode) && Number.isFinite(value) && value >= 0) {
    return formatSerialDate(value, formats.use1904Epoch, formatCode);
  }
  return formatNumber(value);
}

function readSheetCells(
  records: BiffRecord[],
  sharedStrings: string[],
  formats: WorkbookFormats,
): BiffCell[] {
  const cells: BiffCell[] = [];
  const push = (row: number, column: number, text: string) => {
    if (text.length > 0) cells.push({ row, column, text });
  };

  records.forEach((record, index) => {
    const data = record.data;

    switch (record.id) {
      case RECORD.LABELSST:
        push(
          data.readUInt16LE(0),
          data.readUInt16LE(2),
          sharedStrings[data.readUInt32LE(6)] ?? '',
        );
        break;

      case RECORD.LABEL:
        push(data.readUInt16LE(0), data.readUInt16LE(2), readInlineString(data, 6));
        break;

      case RECORD.NUMBER:
        push(
          data.readUInt16LE(0),
          data.readUInt16LE(2),
          numericCellText(data.readDoubleLE(6), data.readUInt16LE(4), formats),
        );
        break;

      case RECORD.RK:
        push(
          data.readUInt16LE(0),
          data.readUInt16LE(2),
          numericCellText(decodeRkNumber(data.readInt32LE(6)), data.readUInt16LE(4), formats),
        );
        break;

      case RECORD.MULRK: {
        const row = data.readUInt16LE(0);
        const firstColumn = data.readUInt16LE(2);
        const count = Math.floor((data.length - 6) / 6);
        for (let offset = 0; offset < count; offset += 1) {
          const base = 4 + offset * 6;
          const xfIndex = data.readUInt16LE(base);
          const value = decodeRkNumber(data.readInt32LE(base + 2));
          push(row, firstColumn + offset, numericCellText(value, xfIndex, formats));
        }
        break;
      }

      case RECORD.BOOLERR: {
        const isError = data.readUInt8(7) === 1;
        const raw = data.readUInt8(6);
        push(data.readUInt16LE(0), data.readUInt16LE(2), isError ? '' : raw ? 'VERDADEIRO' : 'FALSO');
        break;
      }

      case RECORD.FORMULA: {
        const row = data.readUInt16LE(0);
        const column = data.readUInt16LE(2);
        const xfIndex = data.readUInt16LE(4);
        const result = data.subarray(6, 14);

        if (result.readUInt16LE(6) !== FORMULA_RESULT_IS_SPECIAL) {
          push(row, column, numericCellText(result.readDoubleLE(0), xfIndex, formats));
          break;
        }

        const specialKind = result.readUInt8(0);
        if (specialKind === 0) {
          const next = records[index + 1];
          if (next && next.id === RECORD.STRING) {
            push(row, column, readInlineString(next.data, 0));
          }
        } else if (specialKind === 1) {
          push(row, column, result.readUInt8(2) ? 'VERDADEIRO' : 'FALSO');
        }
        break;
      }

      default:
        break;
    }
  });

  return cells;
}

/**
 * As planilhas de um stream `Workbook` BIFF8, com as células que têm conteúdo.
 *
 * Cada célula guarda a própria linha e coluna em vez de entrar numa lista
 * sequencial: é o que impede que uma célula vazia ou uma faixa mesclada — que no
 * BIFF só grava valor na primeira célula — desloque a coluna seguinte e faça o
 * número aparecer sob o rótulo errado.
 *
 * Lança `ProtectedDocumentError` para arquivo cifrado e `MalformedDocumentError`
 * para versão anterior ao BIFF8 ou stream quebrado. Qualquer outra falha de
 * leitura — registro truncado estoura a faixa do buffer — também sai como
 * `MalformedDocumentError`: se escapasse como erro genérico, a fila trataria um
 * arquivo corrompido como problema temporário e repetiria para sempre.
 */
export function readBiffWorkbook(stream: Buffer, maxSheets: number): BiffSheet[] {
  try {
    return parseBiffWorkbook(stream, maxSheets);
  } catch (error) {
    if (error instanceof ProtectedDocumentError || error instanceof MalformedDocumentError) {
      throw error;
    }
    throw new MalformedDocumentError(
      `estrutura do XLS inconsistente: ${error instanceof Error ? error.message : error}`,
    );
  }
}

function parseBiffWorkbook(stream: Buffer, maxSheets: number): BiffSheet[] {
  if (stream.length < 4) {
    throw new MalformedDocumentError('stream Workbook vazio');
  }

  const firstId = stream.readUInt16LE(0);
  if (firstId !== RECORD.BOF) {
    throw new MalformedDocumentError('stream Workbook não começa com BOF');
  }

  const bofData = stream.subarray(4, 4 + stream.readUInt16LE(2));
  const version = bofData.length >= 2 ? bofData.readUInt16LE(0) : 0;
  const substreamType = bofData.length >= 4 ? bofData.readUInt16LE(2) : 0;

  if (version !== BIFF8_VERSION) {
    throw new MalformedDocumentError(
      `versão de XLS anterior ao Excel 97 (BIFF 0x${version.toString(16)}); ` +
        'reabra e salve como .xls do Excel 97-2003 ou .xlsx',
    );
  }
  if (substreamType !== SUBSTREAM_GLOBALS) {
    throw new MalformedDocumentError('stream Workbook não começa pelo substream global');
  }

  const globals = readRecords(stream, 0);
  const { sheets, sharedStrings, formats } = readGlobals(globals);

  if (sheets.length === 0) {
    throw new MalformedDocumentError('nenhuma planilha declarada no XLS');
  }

  return sheets.slice(0, maxSheets).map((sheet) => {
    if (sheet.position + 4 > stream.length) {
      throw new MalformedDocumentError(`posição da planilha "${sheet.name}" fora do stream`);
    }

    const sheetRecords = readRecords(stream, sheet.position);
    const opening = sheetRecords[0];
    if (!opening || opening.id !== RECORD.BOF) {
      throw new MalformedDocumentError(`planilha "${sheet.name}" não começa com BOF`);
    }
    if (opening.data.length >= 4 && opening.data.readUInt16LE(2) !== SUBSTREAM_WORKSHEET) {
      return { name: sheet.name, cells: [] };
    }

    return { name: sheet.name, cells: readSheetCells(sheetRecords, sharedStrings, formats) };
  });
}
