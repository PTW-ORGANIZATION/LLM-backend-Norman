import { describe, expect, it } from 'vitest';
import {
  assembleClientDossier,
  brandGuideOf,
  buildClientCorpus,
  DocumentNoteRow,
  dossierDocuments,
  fingerprintClientNotes,
  parseClientSynthesis,
} from './client-dossier';
import { BrandGuideNote, InvalidNoteContentError } from './note-content';

function summaryNote(overrides: Partial<DocumentNoteRow> = {}): DocumentNoteRow {
  return {
    documentId: 'doc-1',
    kind: 'document_summary',
    filename: 'briefing.pdf',
    scopePath: 'Vitalis/03_Campanhas',
    sourceFingerprint: 'a'.repeat(64),
    content: {
      titulo: 'Briefing de verão',
      tipo: 'briefing',
      idioma: 'pt',
      resumo: 'Campanha de verão com verba de 200 mil.',
      topicos: ['verão'],
      entidades: ['Vitalis'],
    },
    ...overrides,
  };
}

const BRAND: BrandGuideNote = {
  tomDeVoz: 'Direto e caloroso.',
  publico: 'Cliente final.',
  fazer: ['falar simples'],
  evitar: ['jargão'],
  cores: [{ nome: 'verde', hex: '#0F6B3D', uso: 'principal' }],
  tipografia: ['Inter'],
  restricoes: ['margem mínima'],
  proibicoes: ['distorcer o logotipo'],
};

describe('fingerprintClientNotes', () => {
  it('não depende da ordem em que o banco devolveu as linhas', () => {
    const a = summaryNote({ documentId: 'doc-1' });
    const b = summaryNote({ documentId: 'doc-2' });

    expect(fingerprintClientNotes([a, b])).toBe(fingerprintClientNotes([b, a]));
  });

  it.each([
    ['um documento entrou', [summaryNote(), summaryNote({ documentId: 'doc-2' })]],
    ['um documento saiu', []],
    ['um documento foi reingerido', [summaryNote({ sourceFingerprint: 'b'.repeat(64) })]],
    ['uma nota nova apareceu no mesmo documento', [summaryNote(), summaryNote({ kind: 'brand_guide' })]],
  ])('muda quando %s', (_label, notes) => {
    expect(fingerprintClientNotes(notes)).not.toBe(fingerprintClientNotes([summaryNote()]));
  });

  it('acervo idêntico dá a mesma impressão digital', () => {
    expect(fingerprintClientNotes([summaryNote()])).toBe(fingerprintClientNotes([summaryNote()]));
  });
});

describe('dossierDocuments', () => {
  it('inventaria só as notas de resumo, em ordem estável', () => {
    const documents = dossierDocuments(
      [
        summaryNote({ documentId: 'd2', filename: 'zeta.pdf' }),
        summaryNote({ documentId: 'd1', filename: 'alfa.pdf' }),
        summaryNote({ documentId: 'd3', kind: 'brand_guide', filename: 'manual.pdf' }),
      ],
      'document_summary',
      10,
    );

    expect(documents.map((document) => document.arquivo)).toEqual(['alfa.pdf', 'zeta.pdf']);
    expect(documents[0]).toMatchObject({
      pasta: 'Vitalis/03_Campanhas',
      tipo: 'briefing',
      resumo: 'Campanha de verão com verba de 200 mil.',
      topicos: ['verão'],
      entidades: ['Vitalis'],
    });
  });

  it('respeita o teto de documentos', () => {
    const notes = Array.from({ length: 40 }, (_, index) =>
      summaryNote({ documentId: `d${index}`, filename: `arquivo-${index}.pdf` }),
    );

    expect(dossierDocuments(notes, 'document_summary', 5)).toHaveLength(5);
  });

  it('descarta nota cujo conteúdo não tem resumo', () => {
    const quebrada = summaryNote({ documentId: 'd9', content: { titulo: 'sem resumo' } });

    expect(dossierDocuments([quebrada], 'document_summary', 10)).toEqual([]);
  });
});

describe('brandGuideOf', () => {
  it('escolhe a ficha institucional, que é a de pasta mais rasa', () => {
    const institucional = summaryNote({
      documentId: 'd1',
      kind: 'brand_guide',
      filename: 'institucional.pdf',
      scopePath: 'Vitalis/01_Brand_Guide_Institucional',
      content: { ...BRAND, tomDeVoz: 'Institucional.' },
    });
    const produto = summaryNote({
      documentId: 'd2',
      kind: 'brand_guide',
      filename: 'produto.pdf',
      scopePath: 'Vitalis/Linha_X/01_Brand_Guide_Produto',
      content: { ...BRAND, tomDeVoz: 'Do produto.' },
    });

    expect(brandGuideOf([produto, institucional], 'brand_guide')?.tomDeVoz).toBe('Institucional.');
  });

  it('pula ficha ilegível e usa a próxima', () => {
    const quebrada = summaryNote({
      documentId: 'd1',
      kind: 'brand_guide',
      filename: 'a.pdf',
      content: { tomDeVoz: '', cores: [], proibicoes: [] },
    });
    const boa = summaryNote({
      documentId: 'd2',
      kind: 'brand_guide',
      filename: 'b.pdf',
      content: { ...BRAND },
    });

    expect(brandGuideOf([quebrada, boa], 'brand_guide')?.tomDeVoz).toBe('Direto e caloroso.');
  });

  it('cliente sem brand guide devolve nulo', () => {
    expect(brandGuideOf([summaryNote()], 'brand_guide')).toBeNull();
  });
});

describe('buildClientCorpus', () => {
  it('corta no teto de caracteres em vez de estourar a janela do modelo', () => {
    const documents = Array.from({ length: 50 }, (_, index) => ({
      arquivo: `arquivo-${index}.pdf`,
      pasta: 'Vitalis',
      tipo: 'briefing',
      resumo: 'x'.repeat(200),
      topicos: [],
      entidades: [],
    }));

    expect(buildClientCorpus(documents, 800).length).toBeLessThanOrEqual(800);
  });

  it('acervo vazio dá corpus vazio', () => {
    expect(buildClientCorpus([], 1000)).toBe('');
  });
});

describe('assembleClientDossier', () => {
  const synthesis = {
    resumo: 'Cliente de saúde.',
    setor: 'saúde',
    temasRecorrentes: ['verão'],
  };

  it('copia do brand guide em vez de pedir ao modelo de novo', () => {
    const dossier = assembleClientDossier({
      synthesis,
      brandGuide: BRAND,
      documentos: dossierDocuments([summaryNote()], 'document_summary', 10),
    });

    expect(dossier.tomDeVoz).toBe(BRAND.tomDeVoz);
    expect(dossier.cores).toEqual(BRAND.cores);
    expect(dossier.proibicoes).toEqual(BRAND.proibicoes);
    expect(dossier.resumo).toBe('Cliente de saúde.');
    expect(dossier.documentos).toHaveLength(1);
  });

  it('cliente sem brand guide fica com os campos de marca vazios, não ausentes', () => {
    const dossier = assembleClientDossier({ synthesis, brandGuide: null, documentos: [] });

    expect(dossier).toMatchObject({
      tomDeVoz: '',
      publico: '',
      cores: [],
      tipografia: [],
      restricoes: [],
      proibicoes: [],
      documentos: [],
    });
  });
});

describe('parseClientSynthesis', () => {
  it('recusa síntese sem resumo', () => {
    expect(() => parseClientSynthesis({ setor: 'saúde' })).toThrow(InvalidNoteContentError);
  });

  it('normaliza os temas e ignora campo inventado', () => {
    const parsed = parseClientSynthesis({
      resumo: 'Cliente de saúde.',
      setor: 'saúde',
      temasRecorrentes: ['verão', 'Verão', ''],
      confianca: 0.4,
    });

    expect(parsed.temasRecorrentes).toEqual(['verão']);
    expect(parsed).not.toHaveProperty('confianca');
  });
});
