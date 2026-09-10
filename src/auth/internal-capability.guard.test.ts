import { Reflector } from '@nestjs/core';
import { describe, expect, it } from 'vitest';
import { InternalCapabilityGuard } from './internal-capability.guard';
import {
  NORMAN_CAPABILITIES,
  OpenToEveryConsumer,
  RequiresAnyCapability,
  RequiresCapability,
  RequiresCapabilityByScope,
  type InternalCapability,
} from './internal-capabilities';
import type { ConsumerApplication } from './consumer-registry';

function consumidor(capabilities: InternalCapability[]): ConsumerApplication {
  return { name: 'niprofe', token: 't', features: ['chat'], scopes: ['person'], capabilities };
}

function decide(handler: Function, consumer?: ConsumerApplication, body: unknown = {}) {
  const guard = new InternalCapabilityGuard(new Reflector());
  return guard.canActivate({
    getHandler: () => handler,
    getClass: () => class {},
    switchToHttp: () => ({ getRequest: () => ({ consumer, body }) }),
  } as any);
}

class Rotas {
  @RequiresCapability('documents.extract')
  extrai() {}

  @RequiresCapabilityByScope('knowledge.client.write', 'knowledge.system.write')
  registra() {}

  @RequiresAnyCapability('knowledge.client.read', 'knowledge.system.read')
  consulta() {}

  @OpenToEveryConsumer()
  gera() {}

  semDeclaracao() {}
}

describe('InternalCapabilityGuard', () => {
  const rotas = new Rotas();

  it('a capacidade fixa concedida abre a rota', () => {
    expect(decide(rotas.extrai, consumidor(['documents.extract']))).toBe(true);
  });

  it('sem a capacidade fixa, a rota é recusada com o nome dela', () => {
    expect(() => decide(rotas.extrai, consumidor([]))).toThrow('não recebeu documents.extract');
  });

  it('a escrita de cliente não vale para o nível do sistema', () => {
    expect(decide(rotas.registra, consumidor(['knowledge.client.write']))).toBe(true);
    expect(() => decide(
      rotas.registra,
      consumidor(['knowledge.client.write']),
      { scope: 'system' },
    )).toThrow('não recebeu knowledge.system.write');
  });

  it('a escrita do sistema não vale para o acervo de um cliente', () => {
    expect(decide(
      rotas.registra,
      consumidor(['knowledge.system.write']),
      { scope: 'system' },
    )).toBe(true);
    expect(() => decide(
      rotas.registra,
      consumidor(['knowledge.system.write']),
      { clientId: 'cli-1' },
    )).toThrow('não recebeu knowledge.client.write');
  });

  it('corpo ausente vale como nível de cliente, e não como nível do sistema', () => {
    expect(() => decide(rotas.registra, consumidor(['knowledge.system.write']), undefined))
      .toThrow('não recebeu knowledge.client.write');
  });

  it('a rota dos dois níveis aceita qualquer uma das duas leituras', () => {
    expect(decide(rotas.consulta, consumidor(['knowledge.system.read']))).toBe(true);
    expect(decide(rotas.consulta, consumidor(['knowledge.client.read']))).toBe(true);
    expect(() => decide(rotas.consulta, consumidor([]))).toThrow(
      'não recebeu knowledge.client.read ou knowledge.system.read',
    );
  });

  it('rota sem capacidade declarada não autoriza ninguém', () => {
    expect(() => decide(rotas.semDeclaracao, consumidor(NORMAN_CAPABILITIES))).toThrow(
      /não declara capacidade/,
    );
  });

  it('a rota aberta a todo consumidor não exige capacidade nenhuma', () => {
    expect(decide(rotas.gera, consumidor([]))).toBe(true);
  });

  it('sem aplicação identificada, nenhuma capacidade é presumida', () => {
    expect(() => decide(rotas.extrai, undefined)).toThrow('não recebeu documents.extract');
  });

  it('o Norman abre todas as portas internas que os adapters dele usam', () => {
    const norman = { ...consumidor(NORMAN_CAPABILITIES), name: 'norman' };

    expect(decide(rotas.extrai, norman)).toBe(true);
    expect(decide(rotas.registra, norman, { scope: 'system' })).toBe(true);
    expect(decide(rotas.registra, norman, { clientId: 'cli-1' })).toBe(true);
    expect(decide(rotas.consulta, norman)).toBe(true);
  });
});
