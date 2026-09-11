import * as fs from 'fs';
import * as path from 'path';
import { ConfigService } from '@nestjs/config';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TextExtractionService } from './text-extraction.service';
import {
  DocumentTooLargeError,
  EmptyExtractionError,
  MalformedDocumentError,
  ProtectedDocumentError,
  UnsupportedDocumentTypeError,
} from './extracted-text';
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

  const transcrever = transcribe ?? (async () => '');
  const vision = {
    transcribeImage: vi.fn(transcrever),
    transcribeImageWithDiagnosis: vi.fn(async (...args: any[]) => {
      const text = await (transcrever as any)(...args);
      return {
        text,
        model: 'modelo-de-teste',
        rawLength: String(text ?? '').length,
        sentinel: false,
      };
    }),
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

const FIXTURES = path.join(__dirname, '__fixtures__');

function fixture(name: string): Buffer {
  return fs.readFileSync(path.join(FIXTURES, name));
}

function serviceWith(
  overrides: Record<string, unknown>,
  transcribe?: () => Promise<string>,
) {
  const config = {
    get: (key: string, fallback?: unknown) =>
      overrides[key] ?? CONFIG_DEFAULTS[key] ?? fallback,
  } as unknown as ConfigService;

  const vision = {
    transcribeImage: vi.fn(transcribe ?? (async () => '')),
  } as unknown as OllamaVisionService;

  return { service: new TextExtractionService(config, vision), vision };
}

/** Deck mínimo, porém estruturalmente válido, cujo único slide é uma imagem. */
async function buildImageOnlyDeck(): Promise<Buffer> {
  const JSZip = (await import('jszip')).default;
  const zip = new JSZip();
  const relationships = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

  zip.file(
    'ppt/presentation.xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" ' +
      `xmlns:r="${relationships}">` +
      '<p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst></p:presentation>',
  );
  zip.file(
    'ppt/_rels/presentation.xml.rels',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      `<Relationship Id="rId1" Type="${relationships}/slide" Target="slides/slide1.xml"/>` +
      '</Relationships>',
  );
  zip.file(
    'ppt/slides/slide1.xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" ' +
      'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
      `xmlns:r="${relationships}">` +
      '<p:cSld><p:spTree><p:pic><p:blipFill><a:blip r:embed="rId2"/></p:blipFill></p:pic>' +
      '</p:spTree></p:cSld></p:sld>',
  );
  zip.file(
    'ppt/slides/_rels/slide1.xml.rels',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      `<Relationship Id="rId2" Type="${relationships}/image" Target="../media/image1.png"/>` +
      '</Relationships>',
  );
  zip.file('ppt/media/image1.png', Buffer.from('89504e470d0a1a0a', 'hex'));

  return zip.generateAsync({ type: 'nodebuffer' });
}

describe('TextExtractionService — .doc legado', () => {
  it('extrai o arquivo real e registra a origem', async () => {
    const { service } = makeService();
    const result = await service.extract({
      content: fixture('legado.doc'),
      filename: 'legado.doc',
    });

    expect(result.source).toBe('doc');
    expect(result.pages).toHaveLength(1);
    expect(result.pages[0].pageNumber).toBeNull();
    expect(result.pages[0].text).toContain('ORQUIDEA CROMADA 47');
    expect(result.pages[0].text).toContain('Cor primaria | azul-cobalto');
  });

  it('aceita extensão em maiúsculas e mime genérico do armazenamento', async () => {
    const { service } = makeService();
    const result = await service.extract({
      content: fixture('legado.doc'),
      filename: 'LEGADO.DOC',
      mimeType: 'application/octet-stream',
    });

    expect(result.source).toBe('doc');
  });

  it('aceita o mime correto', async () => {
    const { service } = makeService();
    const result = await service.extract({
      content: fixture('legado.doc'),
      filename: 'legado.doc',
      mimeType: 'application/msword',
    });

    expect(result.source).toBe('doc');
  });

  it('aceita nome com espaço e acento', async () => {
    const { service } = makeService();
    const result = await service.extract({
      content: fixture('legado.doc'),
      filename: 'Manual de Marca — Ação 2026.doc',
    });

    expect(result.source).toBe('doc');
    expect(result.pages[0].text).toContain('ORQUIDEA CROMADA 47');
  });

  it('arquivo vazio é falha explícita, não sucesso vazio', async () => {
    const { service } = makeService();
    await expect(
      service.extract({ content: Buffer.alloc(0), filename: 'vazio.doc' }),
    ).rejects.toBeInstanceOf(MalformedDocumentError);
  });

  it('arquivo corrompido é falha explícita', async () => {
    const { service } = makeService();
    await expect(
      service.extract({ content: fixture('legado.doc').subarray(0, 3000), filename: 'meio.doc' }),
    ).rejects.toBeInstanceOf(MalformedDocumentError);
  });
});

describe('TextExtractionService — .xls legado', () => {
  it('produz uma unidade por aba e registra a origem', async () => {
    const { service } = makeService();
    const result = await service.extract({
      content: fixture('legado.xls'),
      filename: 'legado.xls',
    });

    expect(result.source).toBe('xls');
    expect(result.pages.map((page) => page.pageNumber)).toEqual([1, 2]);
    expect(result.pages[0].text).toContain('# Midia');
    expect(result.pages[0].text).toContain('Instagram | 15000');
    expect(result.pages[0].text).toContain('2026-10-01');
    expect(result.pages[0].text).toContain('Total | 23250.5');
    expect(result.pages[1].text).toContain('# Cronograma');
    expect(result.pages[1].text).toContain('ORQUIDEA CROMADA 47');
  });

  it('aceita extensão em maiúsculas e mime genérico do armazenamento', async () => {
    const { service } = makeService();
    const result = await service.extract({
      content: fixture('legado.xls'),
      filename: 'LEGADO.XLS',
      mimeType: 'application/octet-stream',
    });

    expect(result.source).toBe('xls');
    expect(result.pages).toHaveLength(2);
  });

  it('aceita o mime correto', async () => {
    const { service } = makeService();
    const result = await service.extract({
      content: fixture('legado.xls'),
      filename: 'legado.xls',
      mimeType: 'application/vnd.ms-excel',
    });

    expect(result.source).toBe('xls');
  });

  it('aceita nome com espaço e acento', async () => {
    const { service } = makeService();
    const result = await service.extract({
      content: fixture('legado.xls'),
      filename: 'Verba de Mídia — Praças 2026.xls',
    });

    expect(result.source).toBe('xls');
  });

  it('respeita o teto de abas', async () => {
    const { service } = serviceWith({ 'ingestion.maxSheets': 1 });
    const result = await service.extract({
      content: fixture('legado.xls'),
      filename: 'legado.xls',
    });

    expect(result.pages).toHaveLength(1);
  });

  it('arquivo vazio é falha explícita', async () => {
    const { service } = makeService();
    await expect(
      service.extract({ content: Buffer.alloc(0), filename: 'vazio.xls' }),
    ).rejects.toBeInstanceOf(MalformedDocumentError);
  });

  it('arquivo corrompido é falha explícita', async () => {
    const { service } = makeService();
    await expect(
      service.extract({ content: Buffer.from('PK nao sou planilha'), filename: 'ruim.xls' }),
    ).rejects.toBeInstanceOf(MalformedDocumentError);
  });
});

describe('TextExtractionService — .pptx', () => {
  it('produz uma unidade por slide, com título, tabela, gráfico e notas', async () => {
    const { service } = makeService();
    const result = await service.extract({
      content: fixture('apresentacao.pptx'),
      filename: 'apresentacao.pptx',
    });

    expect(result.source).toBe('pptx');
    expect(result.pages.map((page) => page.pageNumber)).toEqual([1, 2, 3]);
    expect(result.pages[0].text).toContain('Campanha Verao 2026');
    expect(result.pages[0].text).toContain('Notas do apresentador');
    expect(result.pages[1].text).toContain('Digital | 62 por cento');
    expect(result.pages[2].text).toContain('Litoral Norte');
  });

  it('aceita extensão em maiúsculas e mime genérico do armazenamento', async () => {
    const { service } = makeService();
    const result = await service.extract({
      content: fixture('apresentacao.pptx'),
      filename: 'APRESENTACAO.PPTX',
      mimeType: 'application/octet-stream',
    });

    expect(result.source).toBe('pptx');
  });

  it('aceita o mime correto', async () => {
    const { service } = makeService();
    const result = await service.extract({
      content: fixture('apresentacao.pptx'),
      filename: 'apresentacao.pptx',
      mimeType:
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    });

    expect(result.source).toBe('pptx');
  });

  it('aplica OCR à imagem do slide sem texto e marca a origem', async () => {
    const { service, vision } = serviceWith(
      {},
      async () => 'Arte do slide: promocao ORQUIDEA CROMADA 47 no litoral',
    );
    const result = await service.extract({
      content: fixture('apresentacao.pptx'),
      filename: 'apresentacao.pptx',
    });

    expect(result.source).toBe('pptx-ocr');
    expect(result.pages.map((page) => page.pageNumber)).toEqual([1, 2, 3, 4]);
    expect(result.pages[3].text).toContain('Arte do slide');
    expect(vision.transcribeImage).toHaveBeenCalledTimes(1);
  });

  it('respeita o teto de imagens enviadas ao OCR', async () => {
    const { service, vision } = serviceWith(
      { 'ingestion.slideOcrMaxImages': 0 },
      async () => 'nao deveria ser usado',
    );
    const result = await service.extract({
      content: fixture('apresentacao.pptx'),
      filename: 'apresentacao.pptx',
    });

    expect(vision.transcribeImage).not.toHaveBeenCalled();
    expect(result.source).toBe('pptx');
    expect(result.pages).toHaveLength(3);
  });

  it('deck feito só de imagem sem OCR aproveitável não entra vazio no acervo', async () => {
    const { service } = makeService();
    await expect(
      service.extract({ content: await buildImageOnlyDeck(), filename: 'arte.pptx' }),
    ).rejects.toBeInstanceOf(EmptyExtractionError);
  });

  it('deck feito só de imagem entra quando o OCR devolve texto', async () => {
    const { service } = serviceWith({}, async () => 'Chamada da campanha lida da arte');
    const result = await service.extract({
      content: await buildImageOnlyDeck(),
      filename: 'arte.pptx',
    });

    expect(result.source).toBe('pptx-ocr');
    expect(result.pages).toHaveLength(1);
    expect(result.pages[0].text).toContain('Chamada da campanha');
  });

  it('arquivo vazio é falha explícita', async () => {
    const { service } = makeService();
    await expect(
      service.extract({ content: Buffer.alloc(0), filename: 'vazio.pptx' }),
    ).rejects.toBeInstanceOf(MalformedDocumentError);
  });

  it('pacote cifrado é falha explícita de proteção', async () => {
    const { service } = makeService();
    const ole = Buffer.concat([
      Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
      Buffer.alloc(512),
    ]);

    await expect(
      service.extract({ content: ole, filename: 'protegido.pptx' }),
    ).rejects.toBeInstanceOf(ProtectedDocumentError);
  });
});

describe('TextExtractionService — teto de tamanho', () => {
  it('recusa arquivo acima do limite antes de tentar interpretá-lo', async () => {
    const { service } = serviceWith({ 'ingestion.maxFileBytes': 1024 });

    await expect(
      service.extract({ content: fixture('legado.xls'), filename: 'legado.xls' }),
    ).rejects.toBeInstanceOf(DocumentTooLargeError);
  });

  it('aceita arquivo dentro do limite', async () => {
    const { service } = serviceWith({ 'ingestion.maxFileBytes': 10485760 });
    const result = await service.extract({
      content: fixture('legado.xls'),
      filename: 'legado.xls',
    });

    expect(result.source).toBe('xls');
  });
});

/**
 * Arquivo de imagem passou a entrar no acervo pelo modelo de visão.
 *
 * O que importa aqui é a diferença de tratamento em relação ao OCR de página:
 * numa página de PDF a imagem é melhoria e a falha é engolida; num arquivo de
 * imagem ela é o documento inteiro, e engolir a falha reportaria "sem texto"
 * quando o problema é o modelo não ter respondido.
 */
describe('TextExtractionService — imagem', () => {
  const PNG = Buffer.from('89504e470d0a1a0a', 'hex');

  it('transcreve a imagem e marca a origem', async () => {
    const { service, vision } = makeService(async () => 'CODIGO DA PECA: ORQUIDEA 47');

    const extracted = await service.extract({
      content: PNG,
      filename: 'peca.png',
      mimeType: 'image/png',
    });

    expect(extracted.source).toBe('image-ocr');
    expect(extracted.pages).toHaveLength(1);
    expect(extracted.pages[0].pageNumber).toBeNull();
    expect(extracted.pages[0].text).toContain('ORQUIDEA 47');
    expect((vision as any).transcribeImageWithDiagnosis).toHaveBeenCalledTimes(1);
  });

  it('a recusa diz qual modelo respondeu e o que ele devolveu', async () => {
    const { service } = makeService(async () => '');

    const erro = await service.extract({
      content: PNG,
      filename: 'sem-texto.png',
      mimeType: 'image/png',
    }).catch((e: Error) => e.message);

    expect(erro).toContain('modelo de visão');
    expect(erro).toContain('modelo-de-teste');
    expect(erro).toContain('sem-texto.png');
  });

  it('imagem sem texto legível é recusada como documento vazio', async () => {
    const { service } = makeService(async () => '   ');

    await expect(service.extract({
      content: PNG,
      filename: 'foto-de-produto.png',
      mimeType: 'image/png',
    })).rejects.toBeInstanceOf(EmptyExtractionError);
  });

  it('falha do modelo de visão sobe como erro, e não como documento vazio', async () => {
    const { service } = makeService(async () => {
      throw new Error('Ollama /api/generate (visão) retornou 500');
    });

    await expect(service.extract({
      content: PNG,
      filename: 'peca.png',
      mimeType: 'image/png',
    })).rejects.toThrow('retornou 500');
  });

  it('o jpeg passa pelo mesmo caminho', async () => {
    const { service } = makeService(async () => 'texto da arte');

    const extracted = await service.extract({
      content: PNG,
      filename: 'arte.jpg',
      mimeType: 'image/jpeg',
    });

    expect(extracted.source).toBe('image-ocr');
  });
});
