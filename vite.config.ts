import { defineConfig } from 'vite';

export default defineConfig({
  // relative paths so the build runs from any subpath:
  // GitHub Pages (/repo-name/), itch.io's CDN, or a local file server
  base: './',
});
