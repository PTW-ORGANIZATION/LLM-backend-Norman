import {
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';
import {
  CLIENT_SCOPE,
  IngestionScope,
  isIngestionScope,
  scopeOwnershipProblem,
} from '../documents/knowledge-scope';

/**
 * O par nível + dono, validado no DTO.
 *
 * Uma única regra para os dois erros simétricos: acervo de cliente sem
 * `clientId` e acervo geral **com** `clientId`. O segundo é o que impede um
 * `clientId` sintético de atravessar a fronteira — mandar um cliente inventado
 * numa fonte compartilhada é a forma de pedir que ela pertença a todos e a um
 * ao mesmo tempo, e nenhuma consulta conseguiria resolver isso depois.
 *
 * O nível ausente vale `client`. Omissão nunca compartilha nada.
 */
@ValidatorConstraint({ name: 'scopeOwnership', async: false })
export class ScopeOwnershipConstraint implements ValidatorConstraintInterface {
  validate(clientId: unknown, args: ValidationArguments): boolean {
    return this.problem(clientId, args) === null;
  }

  defaultMessage(args: ValidationArguments): string {
    return this.problem((args.object as Record<string, unknown>)[args.property], args)
      ?? 'nível de acervo e dono incompatíveis';
  }

  private problem(clientId: unknown, args: ValidationArguments): string | null {
    const declared = (args.object as { scope?: unknown }).scope;
    if (declared !== undefined && !isIngestionScope(declared)) {
      return 'nível de acervo desconhecido';
    }

    // O tipo e o tamanho são conferidos aqui, e não por `@IsOptional` mais
    // `@IsString`: `@IsOptional` desliga **todas** as validações da
    // propriedade quando ela vem ausente, e era justamente a ausência que esta
    // regra precisa recusar no acervo de cliente.
    if (clientId !== undefined && clientId !== null) {
      if (typeof clientId !== 'string') return 'clientId precisa ser texto';
      if (clientId.length > 255) return 'clientId passou de 255 caracteres';
    }

    const scope: IngestionScope = isIngestionScope(declared) ? declared : CLIENT_SCOPE;
    return scopeOwnershipProblem({
      scope,
      clientId: typeof clientId === 'string' ? clientId : null,
    });
  }
}

export function ScopeOwnership(options?: ValidationOptions): PropertyDecorator {
  return (target: object, propertyName: string | symbol) => {
    registerDecorator({
      target: target.constructor,
      propertyName: propertyName as string,
      options,
      constraints: [],
      validator: ScopeOwnershipConstraint,
    });
  };
}
