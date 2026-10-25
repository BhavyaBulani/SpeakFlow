import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/**
 * The frontend is a single-page app served by Vite in development and by the
 * Express server in production (see src/server/app.ts). /api is proxied to the
 * backend in development so the browser only ever talks to one origin.
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    outDir: 'dist/client',
    emptyOutDir: true,
    sourcemap: false,
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: process.env.DEV_API_URL ?? 'http://localhost:8787',
        changeOrigin: false,
      },
    },
  },
});
