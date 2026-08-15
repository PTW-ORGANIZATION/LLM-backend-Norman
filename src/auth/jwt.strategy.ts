import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { JwtPayload } from './auth.service';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(config: ConfigService) {
    super({
      // EventSource nativo do browser não manda header customizado, então o
      // endpoint SSE de streaming de resposta da IA precisa aceitar o token
      // via query string (?token=...) também.
      jwtFromRequest: ExtractJwt.fromExtractors([
        ExtractJwt.fromAuthHeaderAsBearerToken(),
        ExtractJwt.fromUrlQueryParameter('token'),
      ]),
      ignoreExpiration: false,
      secretOrKey: config.get<string>('jwt.secret'),
    });
  }

  // O retorno daqui vira `request.user` em qualquer rota protegida
  async validate(payload: JwtPayload) {
    return {
      userId: payload.sub,
      email: payload.email,
      organizationId: payload.organizationId,
    };
  }
}
