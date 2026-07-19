import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/core.ts',
    react: 'src/react.ts',
  },
  format: ['cjs', 'esm'],
  dts: true,
  splitting: true,
  clean: true,
  minify: true,
  external: ['react'],
});