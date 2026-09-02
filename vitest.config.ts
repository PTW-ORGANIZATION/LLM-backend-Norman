import { defineConfig } from 'vitest/config';
import swc from 'unplugin-swc';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    setupFiles: ['./vitest.setup.ts'],
  },
  // O esbuild do Vite não emite `design:paramtypes`, e sem isso os decorators do
  // Nest e do TypeORM carregam pela metade. O swc emite, como o build de produção.
  plugins: [swc.vite({ module: { type: 'es6' } })],
});
