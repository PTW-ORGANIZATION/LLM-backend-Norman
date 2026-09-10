import { describe, expect, it } from 'vitest';
import { decodeRkNumber, formatSerialDate, isDateFormat } from './xls-biff';

function rk(value: number, isInteger: boolean, dividedByHundred: boolean): number {
  if (isInteger) {
    return (value << 2) | (isInteger ? 0x02 : 0) | (dividedByHundred ? 0x01 : 0);
  }
  const buffer = Buffer.alloc(8);
  buffer.writeDoubleLE(value, 0);
  return (buffer.readInt32LE(4) & ~0x03) | (dividedByHundred ? 0x01 : 0);
}

describe('decodeRkNumber', () => {
  it('lê o inteiro de 30 bits', () => {
    expect(decodeRkNumber(rk(15000, true, false))).toBe(15000);
    expect(decodeRkNumber(rk(-42, true, false))).toBe(-42);
    expect(decodeRkNumber(rk(0, true, false))).toBe(0);
  });

  it('divide por cem quando o bit pede', () => {
    expect(decodeRkNumber(rk(1234, true, true))).toBeCloseTo(12.34, 10);
  });

  it('lê os bits altos de um double', () => {
    expect(decodeRkNumber(rk(8250.5, false, false))).toBeCloseTo(8250.5, 10);
    expect(decodeRkNumber(rk(0.5, false, false))).toBeCloseTo(0.5, 10);
  });
});

describe('isDateFormat', () => {
  it('reconhece os formatos de data embutidos', () => {
    expect(isDateFormat(14, undefined)).toBe(true);
    expect(isDateFormat(22, undefined)).toBe(true);
    expect(isDateFormat(45, undefined)).toBe(true);
  });

  it('não confunde formato numérico com data', () => {
    expect(isDateFormat(0, 'General')).toBe(false);
    expect(isDateFormat(2, '0.00')).toBe(false);
    expect(isDateFormat(3, '#,##0')).toBe(false);
    expect(isDateFormat(1, '0')).toBe(false);
  });

  it('reconhece código de data personalizado', () => {
    expect(isDateFormat(165, 'DD/MM/YYYY')).toBe(true);
    expect(isDateFormat(166, 'yyyy-mm-dd')).toBe(true);
    expect(isDateFormat(167, '[$-409]d/m/yyyy')).toBe(true);
    expect(isDateFormat(168, 'hh:mm:ss')).toBe(true);
  });

  it('ignora letra dentro de literal, senão moeda viraria data', () => {
    expect(isDateFormat(169, '"R$"#,##0.00')).toBe(false);
    expect(isDateFormat(170, '#,##0" un"')).toBe(false);
  });
});

describe('formatSerialDate', () => {
  it('converte o serial na época de 1900', () => {
    expect(formatSerialDate(46296, false, 'DD/MM/YYYY')).toBe('2026-10-01');
    expect(formatSerialDate(46341, false, 'DD/MM/YYYY')).toBe('2026-11-15');
  });

  it('compensa o 29 de fevereiro de 1900 que nunca existiu', () => {
    expect(formatSerialDate(59, false, 'DD/MM/YYYY')).toBe('1900-02-28');
    expect(formatSerialDate(61, false, 'DD/MM/YYYY')).toBe('1900-03-01');
  });

  it('converte o serial na época de 1904, usada pelo Excel de Mac antigo', () => {
    expect(formatSerialDate(0, true, 'DD/MM/YYYY')).toBe('1904-01-01');
    expect(formatSerialDate(366, true, 'DD/MM/YYYY')).toBe('1905-01-01');
  });

  it('mostra só a hora quando o serial não tem parte de data', () => {
    expect(formatSerialDate(0.5, false, 'hh:mm')).toBe('12:00:00');
    expect(formatSerialDate(0.25, false, 'hh:mm:ss')).toBe('06:00:00');
  });

  it('acrescenta a hora a uma data quando o formato pede', () => {
    expect(formatSerialDate(46296.5, false, 'DD/MM/YYYY hh:mm')).toBe('2026-10-01 12:00');
  });

  it('omite a hora quando o formato é só de data', () => {
    expect(formatSerialDate(46296.5, false, 'DD/MM/YYYY')).toBe('2026-10-01');
  });
});
