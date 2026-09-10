import path from 'node:path';
import { defineConfig } from 'vitest/config';
import swc from 'unplugin-swc';

/**
 * A suíte de contrato entre os dois serviços, fora do `npm test` de sempre.
 *
 * Separada porque ela precisa do repositório do Norman ao lado deste — e o
 * `npm test` deste backend tem de continuar rodando sozinho, sem o outro
 * serviço presente. Quando o Norman não está no caminho esperado, esta suíte
 * falha dizendo isso; ela não se ignora em silêncio.
 *
 * O caminho vem de `NORMAN_REPO_PATH` ou do irmão `../Norman`.
 */
const normanRepo = process.env.NORMAN_REPO_PATH
  ? path.resolve(process.env.NORMAN_REPO_PATH)
  : path.resolve(__dirname, '..', '..', 'Norman');

export default defineConfig({
  resolve: {
    alias: {
      '@norman': path.join(normanRepo, 'server'),
      // O `@shared` do Norman: os módulos dele que este contrato carrega —
      // repository e schema do plano de controle — resolvem por este apelido.
      '@shared': path.join(normanRepo, 'shared'),
    },
  },
  server: { fs: { allow: [path.resolve(__dirname, '..'), normanRepo] } },
  test: {
    globals: true,
    environment: 'node',
    include: ['contract/**/*.contract.test.ts'],
    setupFiles: ['./vitest.setup.ts'],
    testTimeout: 180000,
    hookTimeout: 180000,
  },
  plugins: [swc.vite({ module: { type: 'es6' } })],
});
