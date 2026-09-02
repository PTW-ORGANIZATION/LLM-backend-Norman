const SEPARATOR = '\n\n';
const GAP = '\n\n[...]\n\n';

function pickEvenly<T>(items: T[], count: number): T[] {
  if (count >= items.length) return [...items];
  const step = (items.length - 1) / (count - 1);
  const indices = new Set<number>();
  for (let position = 0; position < count; position += 1) {
    indices.add(Math.round(position * step));
  }
  return [...indices].sort((a, b) => a - b).map((index) => items[index]);
}

/**
 * O trecho do documento que vai ao modelo para ele estudar, dentro do teto de
 * caracteres.
 *
 * Documento que não cabe é **amostrado ao longo dele**, e não cortado no começo:
 * um brand guide põe as proibições no fim, e um briefing põe o orçamento na
 * última página. As partes puladas ficam marcadas, para o modelo não costurar
 * como contínuo um texto que não é.
 */
export function buildStudyExcerpt(chunks: string[], maxChars: number): string {
  if (maxChars <= 0) return '';

  const parts = chunks.map((chunk) => String(chunk ?? '').trim()).filter((chunk) => chunk.length > 0);
  if (parts.length === 0) return '';

  const whole = parts.join(SEPARATOR);
  if (whole.length <= maxChars) return whole;

  const average = whole.length / parts.length;
  let count = Math.min(parts.length, Math.max(1, Math.floor(maxChars / Math.max(1, average))));

  while (count > 1) {
    const text = pickEvenly(parts, count).join(GAP);
    if (text.length <= maxChars) return text;
    count -= 1;
  }

  return parts[0].slice(0, maxChars);
}
