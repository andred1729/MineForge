import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    blueprintFixture: 'src/blueprintFixture.ts',
    importBlueprint: 'src/importBlueprint.ts',
    main: 'src/main.ts',
  },
  clean: true,
  dts: true,
  format: ['esm'],
  platform: 'node',
  sourcemap: true,
  target: 'node22',
});
