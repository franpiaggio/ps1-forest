import { defineConfig } from 'vite';

export default defineConfig({
  // GitHub Pages serves the site from /ps1-forest/. Set to '/' for a custom domain.
  base: '/ps1-forest/',
  server: { port: 5188, open: true, host: true, allowedHosts: true },
  build: { target: 'esnext', outDir: 'dist' },
});
