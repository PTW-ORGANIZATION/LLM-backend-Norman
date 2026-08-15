import { createParamDecorator, ExecutionContext } from '@nestjs/common';

export interface AuthenticatedUser {
  userId: string;
  email: string;
  organizationId: string | null;
}

// Uso: async myRoute(@CurrentUser() user: AuthenticatedUser)
// Extrai o que o JwtStrategy.validate() retornou (request.user).
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthenticatedUser => {
    const request = ctx.switchToHttp().getRequest();
    return request.user;
  },
);
