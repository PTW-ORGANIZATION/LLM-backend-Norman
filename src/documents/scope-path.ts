/**
 * Os níveis ancestrais de um caminho de pasta, do cliente até a própria pasta,
 * na forma exata em que o `scope_path` é gravado.
 *
 * É a lista para um `IN`, e não um `LIKE`, de propósito: nome de pasta do Norman
 * contém `_` com frequência (`01_Brand_Guide_Institucional`, e `Jonson___Co` que
 * o `sanitizePathSegment` produz), e `_` é curinga de um caractere no `LIKE`.
 * Um padrão vindo da coluna casaria pasta irmã — exatamente o que a regra de
 * escopo proíbe. Igualdade não tem curinga.
 *
 * Devolve lista vazia para caminho vazio ou com `..`, o que faz a consulta não
 * casar nada em vez de casar demais. Descartar o `..` silenciosamente é a
 * armadilha §4.3 do plano.
 */
export function scopePathAncestors(scopePath: string | null | undefined): string[] {
  const segments = String(scopePath || '')
    .split('/')
    .map((segment) => segment.trim())
    .filter((segment) => segment && segment !== '.');

  if (segments.length === 0) return [];
  if (segments.some((segment) => segment === '..')) return [];

  return segments.map((_, index) => segments.slice(0, index + 1).join('/'));
}
