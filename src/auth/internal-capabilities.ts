import { SetMetadata } from '@nestjs/common';
import { CLIENT_SCOPE, SYSTEM_SCOPE, type IngestionScope } from '../documents/knowledge-scope';

export const INTERNAL_CAPABILITIES = [
  'knowledge.client.read',
  'knowledge.client.write',
  'knowledge.system.read',
  'knowledge.system.write',
  'documents.extract',
  'connections.administer',
] as const;

export type InternalCapability = (typeof INTERNAL_CAPABILITIES)[number];

export function isInternalCapability(value: unknown): value is InternalCapability {
  return typeof value === 'string' && (INTERNAL_CAPABILITIES as readonly string[]).includes(value);
}

export type CapabilityRequirement =
  | { kind: 'open' }
  | { kind: 'fixed'; capability: InternalCapability }
  | { kind: 'byScope'; client: InternalCapability; system: InternalCapability }
  | { kind: 'anyOf'; capabilities: InternalCapability[] };

export const INTERNAL_CAPABILITY_METADATA = 'internal-capability-requirement';

export function RequiresCapability(capability: InternalCapability) {
  return SetMetadata<string, CapabilityRequirement>(INTERNAL_CAPABILITY_METADATA, {
    kind: 'fixed',
    capability,
  });
}

export function RequiresCapabilityByScope(client: InternalCapability, system: InternalCapability) {
  return SetMetadata<string, CapabilityRequirement>(INTERNAL_CAPABILITY_METADATA, {
    kind: 'byScope',
    client,
    system,
  });
}

export function OpenToEveryConsumer() {
  return SetMetadata<string, CapabilityRequirement>(INTERNAL_CAPABILITY_METADATA, {
    kind: 'open',
  });
}

export function RequiresAnyCapability(...capabilities: InternalCapability[]) {
  return SetMetadata<string, CapabilityRequirement>(INTERNAL_CAPABILITY_METADATA, {
    kind: 'anyOf',
    capabilities,
  });
}

export function declaredScope(body: unknown): IngestionScope {
  const scope = (body as { scope?: unknown } | null | undefined)?.scope;
  return scope === SYSTEM_SCOPE ? SYSTEM_SCOPE : CLIENT_SCOPE;
}

export function requiredCapabilities(
  requirement: CapabilityRequirement,
  body: unknown,
): InternalCapability[] {
  if (requirement.kind === 'open') return [];
  if (requirement.kind === 'fixed') return [requirement.capability];
  if (requirement.kind === 'anyOf') return requirement.capabilities;
  return [declaredScope(body) === SYSTEM_SCOPE ? requirement.system : requirement.client];
}

export const NORMAN_CAPABILITIES: InternalCapability[] = [...INTERNAL_CAPABILITIES];

export function grantsCapability(
  granted: readonly string[],
  required: readonly InternalCapability[],
): boolean {
  if (required.length === 0) return true;
  return required.some((capability) => granted.includes(capability));
}
