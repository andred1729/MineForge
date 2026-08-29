import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    main: 'src/main.ts',
  },
  clean: true,
  dts: true,
  format: ['esm'],
  platform: 'node',
  sourcemap: true,
  target: 'node22',
});
