import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { extractDoc, readableDocLines } from './doc.extractor';
import { MalformedDocumentError, ProtectedDocumentError } from './extracted-text';

const FIXTURE = path.join(__dirname, '__fixtures__', 'legado.doc');

function realDoc(): Buffer {
  return fs.readFileSync(FIXTURE);
}

/** O mesmo arquivo real, com o bit `fEncrypted` do FIB ligado. */
function encryptedDoc(): Buffer {
  const CFB = require('cfb');
  const container = CFB.read(realDoc(), { type: 'buffer' });
  const stream = CFB.find(container, 'WordDocument');
  const fib = Buffer.from(stream.content);
  fib.writeUInt16LE(fib.readUInt16LE(10) | 0x0100, 10);
  stream.content = fib;
  return Buffer.from(CFB.write(container, { type: 'buffer' }));
}

describe('readableDocLines', () => {
  it('converte fronteira de célula em separador que sobrevive à normalização', () => {
    expect(readableDocLines('Cor primaria\tazul-cobalto\t')).toBe('Cor primaria | azul-cobalto');
  });

  it('mantém o marcador de lista sem virar célula', () => {
    expect(readableDocLines('\t•\tFachada')).toBe('• Fachada');
    expect(readableDocLines('\t1.\tPrimeiro item')).toBe('1. Primeiro item');
  });

  it('preserva a quebra entre parágrafos', () => {
    expect(readableDocLines('um\ndois')).toBe('um\ndois');
  });

  it('aceita entrada vazia', () => {
    expect(readableDocLines('')).toBe('');
  });
});

describe('extractDoc — arquivo real do Word 97-2003', () => {
  it('lê parágrafo, tabela e lista em ordem legível', async () => {
    const pages = await extractDoc(realDoc());

    expect(pages).toHaveLength(1);
    expect(pages[0].pageNumber).toBeNull();

    const text = pages[0].text;
    expect(text).toContain('Manual de marca legado da Acme Corporation');
    expect(text).toContain('ORQUIDEA CROMADA 47');
    expect(text).toContain('Cor primaria | azul-cobalto');
    expect(text).toContain('Cor secundaria | areia-quente');
    expect(text).toContain('Fachada da loja');
    expect(text).toContain('Frota de entrega');
  });

  it('mantém a ordem do documento', async () => {
    const [page] = await extractDoc(realDoc());
    expect(page.text.indexOf('Manual de marca')).toBeLessThan(page.text.indexOf('Cor primaria'));
    expect(page.text.indexOf('Cor primaria')).toBeLessThan(page.text.indexOf('Fachada da loja'));
  });

  it('recusa arquivo cifrado com erro próprio, não como corrompido', async () => {
    await expect(extractDoc(encryptedDoc())).rejects.toBeInstanceOf(ProtectedDocumentError);
  });

  it('recusa arquivo truncado', async () => {
    await expect(extractDoc(realDoc().subarray(0, 2048))).rejects.toBeInstanceOf(
      MalformedDocumentError,
    );
  });

  it('recusa arquivo que não é um .doc', async () => {
    await expect(extractDoc(Buffer.from('isto nao e um documento'))).rejects.toBeInstanceOf(
      MalformedDocumentError,
    );
  });

  it('recusa arquivo vazio', async () => {
    await expect(extractDoc(Buffer.alloc(0))).rejects.toBeInstanceOf(MalformedDocumentError);
  });
});
