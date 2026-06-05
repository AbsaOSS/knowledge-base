/**
 * vite.config.js — knowledge-base Vite configuration
 *
 * Architecture:
 *  - index.html is the Vite entry (marketplace landing page template)
 *  - src/style.css is the TailwindCSS entry (processed by @tailwindcss/vite)
 *  - The marketplace Vite plugin handles sub-app HTML processing:
 *      • Dev: intercepts /knowledge-base/{slug}/ requests, transforms HTML on-the-fly
 *      • Build: post-processes apps/**\/*.html → dist/{slug}/ after Vite finishes
 */

import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import { marketplacePlugin } from './plugins/marketplace.js';

const PREFIX = process.env.MP_PREFIX || 'knowledge-base';
const HEADLESS = process.env.MP_HEADLESS !== 'false'; // headless by default

export default defineConfig({
  // Never let Vite inject a <base href> — the plugin handles all URL prefixing explicitly.
  base: '/',

  plugins: [
    tailwindcss(),
    marketplacePlugin({ prefix: PREFIX, headless: HEADLESS, appsDir: 'apps' }),
  ],

  css: {
    // Disable CSS modules — we use plain CSS
    modules: false,
  },

  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        // Only the marketplace landing page is a Vite entry.
        // Sub-app HTML files are processed by the marketplace plugin.
        index: 'index.html',
      },
      output: {
        // Emit style.css at the root (not assets/style-[hash].css)
        // so sub-apps can reference /{PREFIX}/style.css reliably.
        assetFileNames: (info) =>
          info.name?.endsWith('.css') ? '[name][extname]' : 'assets/[name]-[hash][extname]',
        entryFileNames: 'assets/[name]-[hash].js',
      },
    },
  },

  server: {
    port: 3000,
    strictPort: true,
    fs: { strict: false },
  },

  preview: {
    port: 3000,
    strictPort: true,
  },
});
