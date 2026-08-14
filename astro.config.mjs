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
    // No assetFileNames override: CSS is content-hashed like every other asset.
    //
    // This used to force the name "style.css" onto every CSS asset so that
    // /{PREFIX}/style.css was a fixed path. Nothing needs a fixed path — the
    // <link> on every page is injected by Astro from Base.astro's CSS import, so
    // it always carries whatever name the bundle was given. Forcing a constant
    // name only made Rollup disambiguate collisions as style.css / style2.css,
    // which the build then had to guess between, and it defeated cache-busting
    // for the one stylesheet every page loads (#50). scripts/build-vite.js still
    // publishes dist/style.css as an alias of this bundle for anything outside
    // this repository that refers to it by that path.
  },
});

