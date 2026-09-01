import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'crypto';

export const INTERNAL_TOKEN_HEADER = 'x-internal-token';

function tokensMatch(received: string, expected: string): boolean {
  const a = Buffer.from(received, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Autoriza as rotas `/internal`, que são chamadas por outro serviço e não por
 * uma pessoa. O JWT do `JwtAuthGuard` é credencial de usuário: ele carrega
 * `sub`/`organizationId` e não faz sentido para o Norman falando com este
 * backend.
 *
 * Fecha por padrão: sem `INTERNAL_API_TOKEN` configurado, nenhuma chamada
 * interna passa. Um segredo em branco não pode virar um backdoor aberto.
 */
@Injectable()
export class InternalAuthGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const expected = (this.config.get<string>('internal.token') || '').trim();
    if (!expected) {
      throw new UnauthorizedException('Integração interna não configurada.');
    }

    const request = context.switchToHttp().getRequest();
    const received = String(request.headers?.[INTERNAL_TOKEN_HEADER] || '').trim();
    if (!received || !tokensMatch(received, expected)) {
      throw new UnauthorizedException('Credencial interna inválida.');
    }

    return true;
  }
}
