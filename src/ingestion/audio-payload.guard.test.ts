import { describe, expect, it } from 'vitest';
import {
  inspectForAudioPayload,
  isAudioMimeType,
  looksLikeAudioBytes,
  looksLikeAudioName,
} from './audio-payload.guard';

function comAssinatura(prefixo: number[] | string, tamanho = 32) {
  const bytes =
    typeof prefixo === 'string'
      ? Array.from(prefixo).map((letra) => letra.charCodeAt(0))
      : prefixo;
  const buffer = Buffer.alloc(tamanho);
  bytes.forEach((byte, indice) => {
    buffer[indice] = byte;
  });
  return buffer;
}

function riff(marca: string) {
  const buffer = comAssinatura('RIFF');
  buffer.write(marca, 8, 'latin1');
  return buffer;
}

describe('isAudioMimeType', () => {
  it('reconhece a família audio/*', () => {
    expect(isAudioMimeType('audio/ogg')).toBe(true);
    expect(isAudioMimeType(' AUDIO/MPEG ')).toBe(true);
  });

  it('não confunde com outros tipos', () => {
    expect(isAudioMimeType('application/pdf')).toBe(false);
    expect(isAudioMimeType(null)).toBe(false);
    expect(isAudioMimeType(undefined)).toBe(false);
  });
});

describe('looksLikeAudioName', () => {
  it('reconhece extensões de áudio', () => {
    expect(looksLikeAudioName('reuniao.ogg')).toBe(true);
    expect(looksLikeAudioName('REUNIAO.MP3')).toBe(true);
    expect(looksLikeAudioName('gravacao.m4a')).toBe(true);
  });

  it('não recusa documento', () => {
    expect(looksLikeAudioName('manual.pdf')).toBe(false);
    expect(looksLikeAudioName('sem-extensao')).toBe(false);
    expect(looksLikeAudioName('')).toBe(false);
    expect(looksLikeAudioName(null)).toBe(false);
  });
});

describe('looksLikeAudioBytes', () => {
  it('reconhece os contêineres de áudio mais comuns', () => {
    expect(looksLikeAudioBytes(riff('WAVE'))).toBe(true);
    expect(looksLikeAudioBytes(comAssinatura('OggS'))).toBe(true);
    expect(looksLikeAudioBytes(comAssinatura('fLaC'))).toBe(true);
    expect(looksLikeAudioBytes(comAssinatura('#!AMR'))).toBe(true);
    expect(looksLikeAudioBytes(comAssinatura('ID3'))).toBe(true);
    expect(looksLikeAudioBytes(comAssinatura([0xff, 0xfb]))).toBe(true);

    const aiff = comAssinatura('FORM');
    aiff.write('AIFF', 8, 'latin1');
    expect(looksLikeAudioBytes(aiff)).toBe(true);
  });

  it('não confunde documento com áudio', () => {
    expect(looksLikeAudioBytes(comAssinatura('%PDF-1.7'))).toBe(false);
    expect(looksLikeAudioBytes(comAssinatura([0x50, 0x4b, 0x03, 0x04]))).toBe(false);
    expect(looksLikeAudioBytes(comAssinatura([0xff, 0xd8, 0xff]))).toBe(false);
    expect(looksLikeAudioBytes(riff('AVI '))).toBe(false);
  });

  it('conteúdo curto demais ou ausente não é julgado como áudio', () => {
    expect(looksLikeAudioBytes(Buffer.from('abc'))).toBe(false);
    expect(looksLikeAudioBytes(null)).toBe(false);
    expect(looksLikeAudioBytes(undefined)).toBe(false);
  });
});

describe('inspectForAudioPayload', () => {
  it('recusa pelo mime type declarado', () => {
    expect(inspectForAudioPayload({ mimeType: 'audio/ogg', filename: 'reuniao.txt' })).toEqual({
      rejected: true,
      reason: 'áudio não é aceito aqui: envie a transcrição em texto',
    });
  });

  it('recusa pela extensão mesmo com mime type genérico', () => {
    expect(
      inspectForAudioPayload({ mimeType: 'application/octet-stream', filename: 'reuniao.wav' }),
    ).toEqual({
      rejected: true,
      reason: 'áudio não é aceito aqui: envie a transcrição em texto',
    });
  });

  it('recusa pelo conteúdo quando o envelope mente', () => {
    expect(
      inspectForAudioPayload({
        mimeType: 'application/pdf',
        filename: 'documento.pdf',
        content: comAssinatura('OggS'),
      }),
    ).toEqual({
      rejected: true,
      reason: 'o conteúdo enviado é áudio: envie a transcrição em texto',
    });
  });

  it('aceita a transcrição em texto', () => {
    expect(
      inspectForAudioPayload({
        mimeType: 'text/markdown',
        filename: 'reuniao.transcricao.md',
        content: Buffer.from('A cor da marca é azul-cobalto.'),
      }),
    ).toEqual({ rejected: false });
  });

  it('aceita documento normal sem conteúdo à mão', () => {
    expect(inspectForAudioPayload({ mimeType: 'application/pdf', filename: 'manual.pdf' })).toEqual({
      rejected: false,
    });
  });
});
