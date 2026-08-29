import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    bootstrap: 'src/bootstrap.ts',
    fixture: 'src/fixture.ts',
    main: 'src/main.ts',
  },
  clean: true,
  dts: true,
  format: ['esm'],
  platform: 'node',
  sourcemap: true,
  target: 'node22',
});
