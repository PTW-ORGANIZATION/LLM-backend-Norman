import {
  IsInt,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

// Caminho de pasta ou arquivo do repositório do Norman: sem travessia e sem
// caractere de controle. O `s` é o que impede a quebra de linha de esconder um
// segmento `..` do lookahead.
const SAFE_PATH = /^(?!.*(?:^|\/)\.\.(?:\/|$))[^\u0000-\u001f]+$/s;

export class RegisterDocumentDto {
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  clientId: string;

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
}

export class ForgetPathDto {
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  clientId: string;

  @IsString()
  @MinLength(1)
  @MaxLength(1000)
  @Matches(SAFE_PATH, { message: 'storagePath precisa ser um caminho simples, sem ".."' })
  storagePath: string;
}

export class ForgetPrefixDto {
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  clientId: string;

  @IsString()
  @MinLength(1)
  @MaxLength(1000)
  @Matches(SAFE_PATH, { message: 'scopePath precisa ser um caminho simples, sem ".."' })
  scopePath: string;
}

export class RenamePrefixDto {
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  clientId: string;

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

export class KnowledgeSearchDto {
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  clientId: string;

  @IsString()
  @MinLength(1)
  @MaxLength(1000)
  @Matches(SAFE_PATH, { message: 'scopePath precisa ser um caminho simples, sem ".."' })
  scopePath: string;

  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  question: string;
}
