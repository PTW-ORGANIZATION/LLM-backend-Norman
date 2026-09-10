import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { ConsumerApplication } from './consumer-registry';
import {
  CapabilityRequirement,
  INTERNAL_CAPABILITY_METADATA,
  grantsCapability,
  requiredCapabilities,
} from './internal-capabilities';

@Injectable()
export class InternalCapabilityGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requirement = this.reflector.get<CapabilityRequirement>(
      INTERNAL_CAPABILITY_METADATA,
      context.getHandler(),
    );

    const request = context.switchToHttp().getRequest();
    const consumer: ConsumerApplication | undefined = request?.consumer;
    const application = consumer?.name ?? 'desconhecida';

    if (!requirement) {
      throw new ForbiddenException(
        'esta rota interna não declara capacidade e por isso não autoriza ninguém',
      );
    }

    if (requirement.kind === 'open') return true;

    const required = requiredCapabilities(requirement, request?.body);
    if (grantsCapability(consumer?.capabilities ?? [], required)) return true;

    throw new ForbiddenException(
      `a aplicação "${application}" não recebeu ${required.join(' ou ')}`,
    );
  }
}
