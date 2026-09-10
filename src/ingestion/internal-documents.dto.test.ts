import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { describe, expect, it } from 'vitest';
import {
  ForgetPathDto,
  ForgetPrefixDto,
  KnowledgeSearchDto,
  RegisterDocumentDto,
  RenamePrefixDto,
  ReprocessDocumentDto,
  ScopeStatusDto,
  SystemOverviewDto,
} from './internal-documents.dto';

function erros<T extends object>(cls: new () => T, payload: Record<string, unknown>) {
  const dto = plainToInstance(cls, payload);
  return validateSync(dto as object, { whitelist: true, forbidNonWhitelisted: true })
    .map((erro) => erro.property);
}

const REGISTRO = {
  scopePath: 'Vitalis/01_Brand',
  storagePath: 'Vitalis/01_Brand/guia.pdf',
  filename: 'guia.pdf',
  sha256: 'a'.repeat(64),
};

/**
 * O par nível + dono, na fronteira.
 *
 * É aqui que o `clientId` sintético é recusado: a validação não deixa uma fonte
 * compartilhada declarar um dono, e não deixa uma fonte de cliente entrar sem
 * dono. Nenhum dos dois erros é corrigido em silêncio.
 */
describe('nível de acervo no contrato de ingestão', () => {
  it('registro de cliente exige clientId', () => {
    expect(erros(RegisterDocumentDto, { ...REGISTRO, clientId: 'cli-1' })).toEqual([]);
    expect(erros(RegisterDocumentDto, { ...REGISTRO, scope: 'client', clientId: 'cli-1' })).toEqual([]);
    expect(erros(RegisterDocumentDto, REGISTRO)).toContain('clientId');
    expect(erros(RegisterDocumentDto, { ...REGISTRO, scope: 'client' })).toContain('clientId');
  });

  it('registro geral do sistema recusa qualquer cliente', () => {
    expect(erros(RegisterDocumentDto, { ...REGISTRO, scope: 'system' })).toEqual([]);
    expect(erros(RegisterDocumentDto, { ...REGISTRO, scope: 'system', clientId: 'cli-1' }))
      .toContain('clientId');
    expect(erros(RegisterDocumentDto, { ...REGISTRO, scope: 'system', clientId: '__system__' }))
      .toContain('clientId');
    expect(erros(RegisterDocumentDto, { ...REGISTRO, scope: 'system', clientId: '*' }))
      .toContain('clientId');
  });

  // Omissão nunca compartilha: o campo ausente vale `client`, que é o nível
  // estreito, e uma requisição antiga não passa a publicar nada por isso.
  it('nível ausente é o de cliente, e nível desconhecido é recusado', () => {
    expect(erros(RegisterDocumentDto, { ...REGISTRO, clientId: 'cli-1' })).toEqual([]);
    expect(erros(RegisterDocumentDto, { ...REGISTRO, scope: 'person', clientId: 'cli-1' }))
      .toContain('scope');
    expect(erros(RegisterDocumentDto, { ...REGISTRO, scope: 'geral' })).toContain('scope');
    expect(erros(RegisterDocumentDto, { ...REGISTRO, scope: 'SYSTEM' })).toContain('scope');
  });

  it.each([
    ['ForgetPathDto', ForgetPathDto, { storagePath: 'Vitalis/a.pdf' }],
    ['ForgetPrefixDto', ForgetPrefixDto, { scopePath: 'Vitalis/01_Brand' }],
    ['RenamePrefixDto', RenamePrefixDto, { fromPath: 'Vitalis/a', toPath: 'Vitalis/b' }],
    ['ScopeStatusDto', ScopeStatusDto, { scopePath: 'Vitalis/01_Brand' }],
    ['KnowledgeSearchDto', KnowledgeSearchDto, { question: 'qual é o tom?' }],
    ['ReprocessDocumentDto', ReprocessDocumentDto, { storagePath: 'Vitalis/a.pdf' }],
  ])('%s aplica a mesma regra de dono', (_nome, cls, corpo) => {
    expect(erros(cls as any, { ...corpo, clientId: 'cli-1' })).toEqual([]);
    expect(erros(cls as any, { ...corpo, scope: 'system' })).toEqual([]);
    expect(erros(cls as any, corpo)).toContain('clientId');
    expect(erros(cls as any, { ...corpo, scope: 'system', clientId: 'cli-1' })).toContain('clientId');
  });

  it('a visão do acervo geral não tem campo de cliente para preencher', () => {
    expect(erros(SystemOverviewDto, {})).toEqual([]);
    expect(erros(SystemOverviewDto, { limit: 10 })).toEqual([]);
    expect(erros(SystemOverviewDto, { clientId: 'cli-1' })).toContain('clientId');
  });
});
