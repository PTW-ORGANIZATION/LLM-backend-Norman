import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { INGESTION_SCOPES, IngestionScope } from '../documents/knowledge-scope';
import { ScopeOwnership } from './scope-ownership.validator';

/**
 * De onde veio o registro de um documento.
 *
 * `repository_sync` é a varredura automática do repositório, e ela respeita a
 * lápide: reindexar sozinha o que alguém revogou desfaria a revogação na
 * próxima sincronização. `administrative` é o envio deliberado de uma pessoa, e
 * é o único que traz o caminho de volta ao acervo.
 */
export const DOCUMENT_ORIGINS = ['repository_sync', 'administrative'] as const;

// Caminho de pasta ou arquivo do repositório do Norman: sem travessia e sem
// caractere de controle. O `s` é o que impede a quebra de linha de esconder um
// segmento `..` do lookahead.
const SAFE_PATH = /^(?!.*(?:^|\/)\.\.(?:\/|$))[^\u0000-\u001f]+$/s;

/**
 * O nível do acervo alvo de uma operação de ingestão.
 *
 * `client` é o acervo privado de um cliente e `system` é o conhecimento geral
 * do Norman. O campo é opcional e ausente vale `client`: nenhuma requisição
 * antiga passa a compartilhar conteúdo por não ter aprendido a mandá-lo, e
 * nenhuma requisição nova compartilha nada sem dizer isso em voz alta.
 */
function scopeField() {
  return applyDecorators(IsOptional(), IsIn(INGESTION_SCOPES));
}

function applyDecorators(...decorators: PropertyDecorator[]): PropertyDecorator {
  return (target, property) => {
    for (const decorator of decorators) decorator(target, property);
  };
}

export class RegisterDocumentDto {
  @scopeField()
  scope?: IngestionScope;

  @ScopeOwnership()
  clientId?: string;

  // Caminho da pasta no repositório do Norman, cru. Nada de re-sanitizar aqui:
  // `sanitizePathSegment` do Norman não é idempotente e reaplicá-la mudaria o
  // nome da pasta do cliente. Travessia é recusada.
  @IsString()
  @MinLength(1)
  @MaxLength(1000)
  @Matches(SAFE_PATH, { message: 'scopePath precisa ser um caminho simples, sem ".."' })
  scopePath: string;

  @IsString()
  @MinLength(1)
  @MaxLength(1000)
  @Matches(SAFE_PATH, { message: 'storagePath precisa ser um caminho simples, sem ".."' })
  storagePath: string;

  @IsString()
  @MinLength(1)
  @MaxLength(500)
  filename: string;

  @IsString()
  @Matches(/^[a-f0-9]{64}$/, { message: 'sha256 precisa ser um hash hexadecimal de 64 caracteres' })
  sha256: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  mimeType?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  sizeBytes?: number;

  @IsOptional()
  @IsIn(DOCUMENT_ORIGINS)
  origin?: (typeof DOCUMENT_ORIGINS)[number];
}

export class ForgetPathDto {
  @scopeField()
  scope?: IngestionScope;

  @ScopeOwnership()
  clientId?: string;

  @IsString()
  @MinLength(1)
  @MaxLength(1000)
  @Matches(SAFE_PATH, { message: 'storagePath precisa ser um caminho simples, sem ".."' })
  storagePath: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  reason?: string;
}

export class ForgetPrefixDto {
  @scopeField()
  scope?: IngestionScope;

  @ScopeOwnership()
  clientId?: string;

  @IsString()
  @MinLength(1)
  @MaxLength(1000)
  @Matches(SAFE_PATH, { message: 'scopePath precisa ser um caminho simples, sem ".."' })
  scopePath: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  reason?: string;
}

export class RevocationStateDto {
  @scopeField()
  scope?: IngestionScope;

  @ScopeOwnership()
  clientId?: string;

  @IsArray()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  @MinLength(1, { each: true })
  @MaxLength(1000, { each: true })
  @Matches(SAFE_PATH, { each: true, message: 'paths precisa conter caminhos simples, sem ".."' })
  paths: string[];
}

export class RenamePrefixDto {
  @scopeField()
  scope?: IngestionScope;

  @ScopeOwnership()
  clientId?: string;

  @IsString()
  @MinLength(1)
  @MaxLength(1000)
  @Matches(SAFE_PATH, { message: 'fromPath precisa ser um caminho simples, sem ".."' })
  fromPath: string;

  @IsString()
  @MinLength(1)
  @MaxLength(1000)
  @Matches(SAFE_PATH, { message: 'toPath precisa ser um caminho simples, sem ".."' })
  toPath: string;
}

export class ClientDossierDto {
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  clientId: string;
}

export class ScopeStatusDto {
  @scopeField()
  scope?: IngestionScope;

  @ScopeOwnership()
  clientId?: string;

  @IsString()
  @MinLength(1)
  @MaxLength(1000)
  @Matches(SAFE_PATH, { message: 'scopePath precisa ser um caminho simples, sem ".."' })
  scopePath: string;
}

export class KnowledgeSearchDto {
  @scopeField()
  scope?: IngestionScope;

  @ScopeOwnership()
  clientId?: string;

  /**
   * A pasta de onde recuperar, ou ausente para consultar o cliente inteiro.
   *
   * Ausente é a consulta geral, e ela não passa por caminho nenhum: a trava é o
   * `clientId`. Exigir um caminho aqui obrigava quem chama a adivinhar a grafia
   * da pasta do cliente, e cliente com espaço, `&`, acento ou underscore tem
   * mais de uma grafia legítima gravada.
   */
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(1000)
  @Matches(SAFE_PATH, { message: 'scopePath precisa ser um caminho simples, sem ".."' })
  scopePath?: string;

  @IsOptional()
  @IsBoolean()
  includeDescendants?: boolean;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(1000, { each: true })
  @Matches(SAFE_PATH, { each: true, message: 'excludeScopePaths aceita caminhos simples, sem ".."' })
  excludeScopePaths?: string[];

  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  question: string;
}

export class ClientOverviewDto {
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  clientId: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  limit?: number;
}

export class ReprocessDocumentDto {
  @scopeField()
  scope?: IngestionScope;

  @ScopeOwnership()
  clientId?: string;

  @IsString()
  @MinLength(1)
  @MaxLength(1000)
  @Matches(SAFE_PATH, { message: 'storagePath precisa ser um caminho simples, sem ".."' })
  storagePath: string;
}

/**
 * O acervo geral do sistema, para a tela administrativa.
 *
 * Não tem `clientId` nem poderia ter: é justamente o nível sem dono cliente, e
 * um campo de cliente aqui convidaria a filtrá-lo por um dono que não existe.
 */
export class SystemOverviewDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  limit?: number;
}
