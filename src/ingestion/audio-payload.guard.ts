const AUDIO_EXTENSIONS = new Set([
  'aac', 'aif', 'aifc', 'aiff', 'amr', 'ape', 'au', 'flac', 'm4a', 'm4b',
  'mka', 'mp3', 'oga', 'ogg', 'opus', 'ra', 'wav', 'weba', 'wma',
]);

function ascii(buffer: Buffer, start: number, length: number) {
  return buffer.subarray(start, start + length).toString('latin1');
}

export function looksLikeAudioBytes(buffer: Buffer | null | undefined): boolean {
  if (!buffer || buffer.length < 12) return false;

  if (ascii(buffer, 0, 4) === 'RIFF' && ascii(buffer, 8, 4) === 'WAVE') return true;
  if (ascii(buffer, 0, 4) === 'FORM' && ascii(buffer, 8, 3) === 'AIF') return true;
  if (ascii(buffer, 0, 4) === 'OggS') return true;
  if (ascii(buffer, 0, 4) === 'fLaC') return true;
  if (ascii(buffer, 0, 5) === '#!AMR') return true;
  if (ascii(buffer, 0, 3) === 'ID3') return true;
  if (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0) return true;

  return false;
}

export function looksLikeAudioName(filename: string | null | undefined): boolean {
  const name = String(filename || '').trim().toLowerCase();
  const dot = name.lastIndexOf('.');
  if (dot < 0) return false;
  return AUDIO_EXTENSIONS.has(name.slice(dot + 1));
}

export function isAudioMimeType(mimeType: string | null | undefined): boolean {
  return String(mimeType || '').trim().toLowerCase().startsWith('audio/');
}

export type AudioPayloadRejection = { rejected: true; reason: string } | { rejected: false };

export function inspectForAudioPayload(input: {
  mimeType?: string | null;
  filename?: string | null;
  content?: Buffer | null;
}): AudioPayloadRejection {
  if (isAudioMimeType(input.mimeType)) {
    return { rejected: true, reason: 'áudio não é aceito aqui: envie a transcrição em texto' };
  }
  if (looksLikeAudioName(input.filename)) {
    return { rejected: true, reason: 'áudio não é aceito aqui: envie a transcrição em texto' };
  }
  if (looksLikeAudioBytes(input.content)) {
    return { rejected: true, reason: 'o conteúdo enviado é áudio: envie a transcrição em texto' };
  }
  return { rejected: false };
}
