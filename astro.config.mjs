import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';

const PREFIX = 'knowledge-base';

export default defineConfig({
  base: '/knowledge-base',
  output: 'static',

  vite: {
    plugins: [
      tailwindcss(),
      {
        // Rewrites /__wf/knowledge-base/* → /knowledge-base/* for local fragment
        // testing via `astro preview`. In production nginx handles this rewrite.
        name: 'wf-fragment-alias',
        configurePreviewServer(server) {
          server.middlewares.use((req, _res, next) => {
            if (req.url?.startsWith(`/__wf/${PREFIX}`)) {
              req.url = req.url.replace(`/__wf/${PREFIX}`, `/${PREFIX}`);
            }
            next();
          });
        },
      },
    ],
    css: { modules: false },
    build: {
      rollupOptions: {
        output: {
          // Stable filename so sub-app pages can reference /{PREFIX}/style.css
          assetFileNames: (info) =>
            info.names?.some(n => n.endsWith('.css')) ? 'style.css' : '_astro/[name]-[hash][extname]',
        },
      },
    },
  },
});

