import { ConfigService } from '@nestjs/config';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TextExtractionService } from './text-extraction.service';
import { EmptyExtractionError, UnsupportedDocumentTypeError } from './extracted-text';
import { OllamaVisionService } from '../../ollama/ollama-vision.service';

function buildPdf(pageTexts: Array<string | null>): Buffer {
  const objects: string[] = [];
  const pageCount = pageTexts.length;
  const fontId = 3 + pageCount * 2;

  objects.push('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
  objects.push(
    `2 0 obj\n<< /Type /Pages /Kids [${pageTexts
      .map((_, index) => `${3 + index * 2} 0 R`)
      .join(' ')}] /Count ${pageCount} >>\nendobj\n`,
  );

  pageTexts.forEach((text, index) => {
    const pageId = 3 + index * 2;
    objects.push(
      `${pageId} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
        `/Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${pageId + 1} 0 R >>\nendobj\n`,
    );
    const stream =
      text === null
        ? '0 0 0 RG'
        : `BT /F1 18 Tf 72 700 Td (${text.replace(/([()\\])/g, '\\$1')}) Tj ET`;
    objects.push(`${pageId + 1} 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}\nendstream\nendobj\n`);
  });

  objects.push(`${fontId} 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n`);

  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (const object of objects) {
    offsets.push(pdf.length);
    pdf += object;
  }
  const xrefPosition = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPosition}\n%%EOF\n`;

  return Buffer.from(pdf, 'latin1');
}

async function buildDocx(paragraphs: string[]): Promise<Buffer> {
  const JSZip = (await import('jszip')).default;
  const zip = new JSZip();

  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
      '</Types>',
  );
  zip.folder('_rels')?.file(
    '.rels',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
      '</Relationships>',
  );
  zip.folder('word')?.file(
    'document.xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
      paragraphs.map((text) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`).join('') +
      '</w:body></w:document>',
  );

  return zip.generateAsync({ type: 'nodebuffer' });
}

async function buildXlsx(sheets: Array<{ name: string; rows: Array<Array<string | number>> }>) {
  const ExcelJS = await import('exceljs');
  const workbook = new ExcelJS.Workbook();
  for (const sheet of sheets) {
    const worksheet = workbook.addWorksheet(sheet.name);
    for (const row of sheet.rows) worksheet.addRow(row);
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

const CONFIG_DEFAULTS: Record<string, unknown> = {
  'ingestion.ocrMaxPages': 20,
  'ingestion.ocrScale': 2,
  'ingestion.ocrTimeoutMs': 180000,
};

function makeService(transcribe?: () => Promise<string>) {
  const config = {
    get: (key: string, fallback?: unknown) => CONFIG_DEFAULTS[key] ?? fallback,
  } as unknown as ConfigService;

  const vision = {
    transcribeImage: vi.fn(transcribe ?? (async () => '')),
  } as unknown as OllamaVisionService;

  return { service: new TextExtractionService(config, vision), vision };
}

describe('TextExtractionService — PDF', () => {
  let service: TextExtractionService;
  let vision: OllamaVisionService;

  beforeEach(() => {
    ({ service, vision } = makeService());
  });

  it('lê a camada de texto com o número de cada página', async () => {
    const result = await service.extract({
      content: buildPdf(['Contrato de marca da Acme Corporation', 'Tom de voz e restricoes da marca']),
      filename: 'contrato.pdf',
    });

    expect(result.source).toBe('pdf-text-layer');
    expect(result.pages.map((page) => page.pageNumber)).toEqual([1, 2]);
    expect(result.pages[0].text).toContain('Contrato de marca');
    expect(result.pages[1].text).toContain('Tom de voz');
    expect(vision.transcribeImage).not.toHaveBeenCalled();
  });

  it('cai para OCR quando a página não tem camada de texto', async () => {
    const ocr = makeService(async () => 'Texto lido da pagina escaneada pelo modelo de visao');
    const result = await ocr.service.extract({
      content: buildPdf([null]),
      filename: 'escaneado.pdf',
    });

    expect(result.source).toBe('pdf-ocr');
    expect(ocr.vision.transcribeImage).toHaveBeenCalledTimes(1);
    expect(result.pages[0].text).toContain('pagina escaneada');
    expect(result.pages[0].pageNumber).toBe(1);
  });

  it('não chama OCR para página que já tem texto suficiente', async () => {
    const ocr = makeService(async () => 'nao deveria ser usado');
    await ocr.service.extract({
      content: buildPdf(['Texto longo o bastante para dispensar o reconhecimento optico']),
      filename: 'texto.pdf',
    });

    expect(ocr.vision.transcribeImage).not.toHaveBeenCalled();
  });

  it('PDF sem texto e sem OCR aproveitável é falha, não sucesso vazio', async () => {
    await expect(
      service.extract({ content: buildPdf([null]), filename: 'branco.pdf' }),
    ).rejects.toBeInstanceOf(EmptyExtractionError);
  });

  it('respeita o teto de páginas de OCR', async () => {
    const config = {
      get: (key: string, fallback?: unknown) =>
        key === 'ingestion.ocrMaxPages' ? 2 : (CONFIG_DEFAULTS[key] ?? fallback),
    } as unknown as ConfigService;
    const vision = {
      transcribeImage: vi.fn(async () => 'texto reconhecido da pagina'),
    } as unknown as OllamaVisionService;

    const limited = new TextExtractionService(config, vision);
    await limited.extract({ content: buildPdf([null, null, null, null]), filename: 'longo.pdf' });

    expect(vision.transcribeImage).toHaveBeenCalledTimes(2);
  });
});

describe('TextExtractionService — outros formatos', () => {
  it('extrai DOCX como página única sem número', async () => {
    const { service } = makeService();
    const result = await service.extract({
      content: await buildDocx(['Primeiro paragrafo do briefing', 'Segundo paragrafo']),
      filename: 'briefing.docx',
    });

    expect(result.source).toBe('docx');
    expect(result.pages).toHaveLength(1);
    expect(result.pages[0].pageNumber).toBeNull();
    expect(result.pages[0].text).toContain('Primeiro paragrafo do briefing');
    expect(result.pages[0].text).toContain('Segundo paragrafo');
  });

  it('extrai XLSX com uma página por aba', async () => {
    const { service } = makeService();
    const result = await service.extract({
      content: await buildXlsx([
        { name: 'Midia', rows: [['Canal', 'Verba'], ['Instagram', 15000]] },
        { name: 'Cronograma', rows: [['Etapa', 'Prazo'], ['Entrega', '2026-10-01']] },
      ]),
      filename: 'plano.xlsx',
    });

    expect(result.source).toBe('xlsx');
    expect(result.pages.map((page) => page.pageNumber)).toEqual([1, 2]);
    expect(result.pages[0].text).toContain('Midia');
    expect(result.pages[0].text).toContain('Instagram | 15000');
    expect(result.pages[1].text).toContain('Cronograma');
  });

  it('extrai texto puro sem número de página', async () => {
    const { service } = makeService();
    const result = await service.extract({
      content: Buffer.from('anotacoes de reuniao\n\nsegunda linha', 'utf8'),
      filename: 'notas.md',
    });

    expect(result.source).toBe('plain');
    expect(result.pages).toEqual([
      { pageNumber: null, text: 'anotacoes de reuniao\n\nsegunda linha' },
    ]);
  });

  it('arquivo de texto vazio é falha, não sucesso vazio', async () => {
    const { service } = makeService();
    await expect(
      service.extract({ content: Buffer.from('   \n  ', 'utf8'), filename: 'vazio.txt' }),
    ).rejects.toBeInstanceOf(EmptyExtractionError);
  });

  it('recusa tipo não suportado', async () => {
    const { service } = makeService();
    await expect(
      service.extract({ content: Buffer.from('PK'), filename: 'acervo.zip' }),
    ).rejects.toBeInstanceOf(UnsupportedDocumentTypeError);
  });
});
