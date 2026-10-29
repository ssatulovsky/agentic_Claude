import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: ['./test/preparacionGlobal.ts'],
    include: ['test/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // Los archivos comparten una base de datos de prueba; cada uno crea sus propios datos.
    fileParallelism: false,
  },
});
