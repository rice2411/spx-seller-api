import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['cjs', 'esm'],
  dts: true,
  target: 'node22',
  platform: 'node',
  sourcemap: true,
  clean: true,
});
