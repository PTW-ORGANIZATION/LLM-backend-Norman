import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { extractXls, layoutSheetRows } from './xls.extractor';
import { MalformedDocumentError, ProtectedDocumentError } from './extracted-text';

const FIXTURE = path.join(__dirname, '__fixtures__', 'legado.xls');

function realXls(): Buffer {
  return fs.readFileSync(FIXTURE);
}

function biffRecord(id: number, data: Buffer): Buffer {
  const header = Buffer.alloc(4);
  header.writeUInt16LE(id, 0);
  header.writeUInt16LE(data.length, 2);
  return Buffer.concat([header, data]);
}

function workbookWith(records: Buffer[]): Buffer {
  const CFB = require('cfb');
  const container = CFB.utils.cfb_new();
  CFB.utils.cfb_add(container, 'Workbook', Buffer.concat(records));
  return Buffer.from(CFB.write(container, { type: 'buffer' }));
}

function bof(version: number): Buffer {
  const data = Buffer.alloc(16);
  data.writeUInt16LE(version, 0);
  data.writeUInt16LE(0x0005, 2);
  return biffRecord(0x0809, data);
}

describe('layoutSheetRows', () => {
  it('mantém o valor na coluna original quando há buraco no meio', () => {
    expect(
      layoutSheetRows([
        { row: 0, column: 0, text: 'A' },
        { row: 0, column: 2, text: 'C' },
      ]),
    ).toEqual(['A |  | C']);
  });

  it('descarta a coluna vazia no fim da linha', () => {
    expect(layoutSheetRows([{ row: 0, column: 0, text: 'A' }])).toEqual(['A']);
  });

  it('ordena por linha e descarta linha inteiramente vazia', () => {
    expect(
      layoutSheetRows([
        { row: 3, column: 0, text: 'depois' },
        { row: 0, column: 0, text: 'antes' },
      ]),
    ).toEqual(['antes', 'depois']);
  });

  it('devolve lista vazia para planilha sem célula', () => {
    expect(layoutSheetRows([])).toEqual([]);
  });
});

describe('extractXls — arquivo real do Excel 97-2003', () => {
  it('produz uma página por aba, com o nome da aba', async () => {
    const pages = await extractXls(realXls(), 100);

    expect(pages).toHaveLength(2);
    expect(pages.map((page) => page.pageNumber)).toEqual([1, 2]);
    expect(pages[0].text).toContain('# Midia');
    expect(pages[1].text).toContain('# Cronograma');
  });

  it('preserva números, inteiros e decimais', async () => {
    const [midia] = await extractXls(realXls(), 100);
    expect(midia.text).toContain('Instagram | 15000 | ');
    expect(midia.text).toContain('Radio | 8250.5 | ');
  });

  it('preserva datas como ISO, igual ao extrator de XLSX', async () => {
    const pages = await extractXls(realXls(), 100);
    expect(pages[0].text).toContain('2026-10-01');
    expect(pages[0].text).toContain('2026-11-15');
    expect(pages[1].text).toContain('2026-12-20');
  });

  it('usa o resultado da fórmula que ficou guardado no arquivo', async () => {
    const [midia] = await extractXls(realXls(), 100);
    expect(midia.text).toContain('Total | 23250.5');
  });

  it('não desloca a coluna quando a célula do meio está vazia', async () => {
    const pages = await extractXls(realXls(), 100);
    expect(pages[1].text).toContain(
      'Observacao depois de uma linha vazia |  | coluna C com a B vazia',
    );
  });

  it('respeita o teto de abas', async () => {
    const pages = await extractXls(realXls(), 1);
    expect(pages).toHaveLength(1);
    expect(pages[0].text).toContain('# Midia');
  });

  it('recusa arquivo cifrado com erro próprio', async () => {
    const filePass = biffRecord(0x002f, Buffer.alloc(2));
    const stream = workbookWith([bof(0x0600), filePass, biffRecord(0x000a, Buffer.alloc(0))]);
    await expect(extractXls(stream, 100)).rejects.toBeInstanceOf(ProtectedDocumentError);
  });

  it('recusa versão anterior ao Excel 97, dizendo o que fazer', async () => {
    const stream = workbookWith([bof(0x0500), biffRecord(0x000a, Buffer.alloc(0))]);
    await expect(extractXls(stream, 100)).rejects.toThrow(/anterior ao Excel 97/);
    await expect(extractXls(stream, 100)).rejects.toBeInstanceOf(MalformedDocumentError);
  });

  it('recusa arquivo que não é OLE', async () => {
    await expect(extractXls(Buffer.from('nao e uma planilha'), 100)).rejects.toBeInstanceOf(
      MalformedDocumentError,
    );
  });

  it('recusa arquivo vazio', async () => {
    await expect(extractXls(Buffer.alloc(0), 100)).rejects.toBeInstanceOf(MalformedDocumentError);
  });

  it('recusa OLE sem stream Workbook', async () => {
    const CFB = require('cfb');
    const container = CFB.utils.cfb_new();
    CFB.utils.cfb_add(container, 'OutraCoisa', Buffer.from('x'));
    const stream = Buffer.from(CFB.write(container, { type: 'buffer' }));
    await expect(extractXls(stream, 100)).rejects.toThrow(/sem stream Workbook/);
  });

  it('recusa stream que não começa com BOF', async () => {
    const stream = workbookWith([biffRecord(0x000a, Buffer.alloc(0))]);
    await expect(extractXls(stream, 100)).rejects.toBeInstanceOf(MalformedDocumentError);
  });

  it('trata registro truncado como corrupção, não como falha temporária', async () => {
    const boundsheetCurto = biffRecord(0x0085, Buffer.alloc(2));
    const stream = workbookWith([
      bof(0x0600),
      boundsheetCurto,
      biffRecord(0x000a, Buffer.alloc(0)),
    ]);

    await expect(extractXls(stream, 100)).rejects.toBeInstanceOf(MalformedDocumentError);
  });

  it('recusa registro cujo tamanho passa do fim do stream', async () => {
    const cabecalhoMentiroso = Buffer.alloc(4);
    cabecalhoMentiroso.writeUInt16LE(0x0085, 0);
    cabecalhoMentiroso.writeUInt16LE(5000, 2);
    const stream = workbookWith([bof(0x0600), cabecalhoMentiroso]);

    await expect(extractXls(stream, 100)).rejects.toBeInstanceOf(MalformedDocumentError);
  });
});
