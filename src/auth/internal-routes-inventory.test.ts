import { PATH_METADATA } from '@nestjs/common/constants';
import { describe, expect, it } from 'vitest';
import { InternalGenerationController } from '../gateway/internal-generation.controller';
import { InternalDocumentsController } from '../ingestion/internal-documents.controller';
import { InternalKnowledgeController } from '../ingestion/internal-knowledge.controller';
import { NORMAN_FEATURES, resolveConsumers } from './consumer-registry';
import {
  CapabilityRequirement,
  INTERNAL_CAPABILITIES,
  INTERNAL_CAPABILITY_METADATA,
  requiredCapabilities,
} from './internal-capabilities';

const CONTROLLERS = [
  InternalDocumentsController,
  InternalKnowledgeController,
  InternalGenerationController,
];

function inventario() {
  const rotas: Array<{
    controller: string;
    handler: string;
    path: unknown;
    requirement: CapabilityRequirement | undefined;
  }> = [];

  for (const controller of CONTROLLERS) {
    const prototype = controller.prototype as unknown as Record<string, unknown>;
    for (const handler of Object.getOwnPropertyNames(prototype)) {
      if (handler === 'constructor') continue;
      const method = prototype[handler];
      if (typeof method !== 'function') continue;
      const path = Reflect.getMetadata(PATH_METADATA, method);
      if (path === undefined) continue;
      rotas.push({
        controller: controller.name,
        handler,
        path,
        requirement: Reflect.getMetadata(INTERNAL_CAPABILITY_METADATA, method),
      });
    }
  }

  return rotas;
}

describe('inventário das rotas internas', () => {
  it('há rotas para inventariar nos três controllers internos', () => {
    const porController = new Set(inventario().map((rota) => rota.controller));

    expect(porController).toEqual(
      new Set(['InternalDocumentsController', 'InternalKnowledgeController', 'InternalGenerationController']),
    );
  });

  it('toda rota interna declara o que exige, sem exceção implícita', () => {
    const semDeclaracao = inventario()
      .filter((rota) => !rota.requirement)
      .map((rota) => `${rota.controller}.${rota.handler}`);

    expect(semDeclaracao).toEqual([]);
  });

  it('nenhuma rota de documento ou conhecimento fica aberta a todo consumidor', () => {
    const abertas = inventario()
      .filter((rota) => rota.controller !== 'InternalGenerationController')
      .filter((rota) => rota.requirement?.kind === 'open')
      .map((rota) => `${rota.controller}.${rota.handler}`);

    expect(abertas).toEqual([]);
  });

  it('as rotas administrativas de conexão exigem a capacidade de conexão', () => {
    const administrativas = inventario().filter(
      (rota) => rota.controller === 'InternalGenerationController'
        && String(rota.path).startsWith('connections'),
    );

    expect(administrativas.length).toBeGreaterThan(0);
    for (const rota of administrativas) {
      expect(requiredCapabilities(rota.requirement!, {})).toEqual(['connections.administer']);
    }
  });

  it('só as rotas de geração e a de descoberta ficam abertas a todo consumidor', () => {
    const abertas = inventario()
      .filter((rota) => rota.requirement?.kind === 'open')
      .map((rota) => rota.handler)
      .sort();

    expect(abertas).toEqual(['capabilities', 'complete', 'stream']);
  });

  it('toda capacidade declarada em rota existe no catálogo', () => {
    for (const rota of inventario()) {
      for (const capability of requiredCapabilities(rota.requirement!, { scope: 'system' })) {
        expect(INTERNAL_CAPABILITIES).toContain(capability);
      }
      for (const capability of requiredCapabilities(rota.requirement!, {})) {
        expect(INTERNAL_CAPABILITIES).toContain(capability);
      }
    }
  });

  it('o Norman recebe a capacidade de cada rota interna, nos dois níveis', () => {
    const [norman] = resolveConsumers({ INTERNAL_API_TOKEN: 'segredo-norman' });

    for (const rota of inventario()) {
      const exigidas = [
        ...requiredCapabilities(rota.requirement!, {}),
        ...requiredCapabilities(rota.requirement!, { scope: 'system' }),
      ];
      for (const capability of exigidas) {
        expect(norman.capabilities).toContain(capability);
      }
    }
  });

  it('o Norman continua com as operações de geração dos adapters dele', () => {
    const [norman] = resolveConsumers({ INTERNAL_API_TOKEN: 'segredo-norman' });

    expect(norman.features).toEqual(NORMAN_FEATURES);
  });
});
