// O Norman cria "01_Brand_Guide_Institucional" na pasta do cliente e
// "01_Brand_Guide_Produto" na do produto, e o arquivo enviado na criação do
// cliente cai lá dentro. Os outros termos são os que aparecem no nome do
// arquivo quando ele foi parar noutro lugar.
const BRAND_GUIDE_TERMS = [
  'brand guide',
  'brandguide',
  'brand book',
  'brandbook',
  'manual de marca',
  'manual da marca',
  'guia de marca',
  'identidade visual',
  'style guide',
];

function normalize(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Se este arquivo merece a extração dirigida de brand guide.
 *
 * Olha a pasta e o nome do arquivo **sem reescrevê-los**: o caminho gravado é o
 * que a busca usa, e re-sanitizá-lo mudaria o nome da pasta do cliente
 * (`sanitizePathSegment` do Norman não é idempotente). A normalização daqui
 * serve só para comparar, e o resultado é descartado.
 */
export function looksLikeBrandGuide(input: {
  scopePath?: string | null;
  filename?: string | null;
}): boolean {
  const haystack = normalize(`${input.scopePath ?? ''} ${input.filename ?? ''}`);
  return BRAND_GUIDE_TERMS.some((term) => haystack.includes(term));
}
