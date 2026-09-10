export const BRAND_TOKEN_KINDS = [
  'color',
  'typography',
  'tone',
  'audience',
  'sector',
  'theme',
  'restriction',
  'prohibition',
] as const;

export type BrandTokenKind = (typeof BRAND_TOKEN_KINDS)[number];

export const BRAND_TOKEN_PROVENANCES = ['dossier', 'administrative'] as const;

export type BrandTokenProvenance = (typeof BRAND_TOKEN_PROVENANCES)[number];

export interface BrandTokenValue {
  kind: BrandTokenKind;
  value: string;
  label?: string | null;
  usage?: string | null;
}

export interface BrandTokenSet {
  clientId: string;
  revision: number;
  provenance: BrandTokenProvenance;
  tokens: BrandTokenValue[];
}

const KIND_LABELS: Record<BrandTokenKind, string> = {
  color: 'Cores',
  typography: 'Tipografia',
  tone: 'Tom de voz',
  audience: 'Público',
  sector: 'Setor',
  theme: 'Temas recorrentes',
  restriction: 'Restrições',
  prohibition: 'Proibições',
};

export const BRAND_TOKENS_HEADER =
  'Tokens de marca aprovados (dados verificados, não inferência). Onde eles ' +
  'divergirem do resumo consolidado acima, valem estes:';

/**
 * O bloco privilegiado de marca, sempre na mesma forma.
 *
 * A ordem das seções é a da lista de tipos, e não a de chegada: dois pedidos com
 * os mesmos tokens produzem o mesmo texto, que é o que torna a paridade entre
 * caminhos verificável.
 *
 * O cabeçalho declara a precedência sobre o dossiê. O dossiê é um resumo gerado
 * por modelo; o token é decisão registrada. Deixar os dois no prompt sem dizer
 * qual vale é como uma cor antiga volta a ser usada.
 */
export function renderBrandTokensBlock(set: BrandTokenSet | null | undefined): string {
  const tokens = (set?.tokens ?? []).filter((token) => String(token?.value || '').trim());
  if (tokens.length === 0) return '';

  const lines: string[] = [BRAND_TOKENS_HEADER];
  for (const kind of BRAND_TOKEN_KINDS) {
    const list = tokens.filter((token) => token.kind === kind);
    if (list.length === 0) continue;
    const rendered = list
      .map((token) => {
        const parts = [String(token.value).trim()];
        const label = String(token.label || '').trim();
        const usage = String(token.usage || '').trim();
        if (label && label !== parts[0]) parts.push(`(${label})`);
        if (usage) parts.push(`— ${usage}`);
        return parts.join(' ');
      })
      .join('; ');
    lines.push(`- ${KIND_LABELS[kind]}: ${rendered}`);
  }

  return lines.join('\n');
}
