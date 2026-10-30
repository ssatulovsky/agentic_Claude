import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// La interfaz se sirve desde el mismo servidor de la API, bajo /app/.
export default defineConfig({
  root: __dirname,
  base: '/app/',
  plugins: [react()],
  build: { outDir: '../dist-web', emptyOutDir: true, sourcemap: false },
  server: { proxy: { '/api': 'http://localhost:3000' } },
});
