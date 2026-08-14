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
          // Sub-app pages reference the marketplace stylesheet at the fixed path
          // /{PREFIX}/style.css, so that one asset — and only it — gets a stable,
          // unhashed name. It is identified by the sentinel declaration
          // src/styles/marketplace.css carries, not by "it happens to be CSS":
          // forcing the name on *every* CSS asset made Rollup disambiguate the
          // collisions as style.css / style2.css / …, and the build then had to
          // guess which of them the pages meant (#50). Rollup's own name for the
          // asset is no help — it is whichever component pulled the CSS in.
          // Every other CSS asset keeps its content hash.
          assetFileNames: (info) =>
            String(info.source ?? '').includes('--mp-marketplace-stylesheet')
              ? 'style.css'
              : '_astro/[name]-[hash][extname]',
        },
      },
    },
  },
});

