import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';
import { BASE_PATH, PATH_PREFIX } from './src/utils/config.js';

export default defineConfig({
  base: BASE_PATH,
  output: 'static',

  build: {
    // No page links a stylesheet from its <head>. The knowledge base stylesheet
    // is inlined into every <body> by Base.astro (a `?inline` import), and the
    // one sheet Astro still collects on its own — the ClientRouter's
    // route-announcer rule — is inlined here rather than emitted as a <link>.
    // Inside a web fragment a head <link> is exactly the node reframed may lose
    // or duplicate across a ClientRouter swap (web-fragments #297), so the
    // deployment keeps none. See src/utils/css-layers.js for the whole picture.
    inlineStylesheets: 'always',
  },

  vite: {
    plugins: [
      tailwindcss(),
      {
        // Rewrites /__wf/knowledge-base/* → /knowledge-base/* for local fragment
        // testing via `astro preview`. In production nginx handles this rewrite.
        name: 'wf-fragment-alias',
        configurePreviewServer(server) {
          server.middlewares.use((req, _res, next) => {
            if (req.url?.startsWith(`/__wf/${PATH_PREFIX}`)) {
              req.url = req.url.replace(`/__wf/${PATH_PREFIX}`, BASE_PATH);
            }
            next();
          });
        },
      },
    ],
    css: { modules: false },
    build: {
      // Astro inlines a component <script> smaller than this limit straight
      // into the page. The deployment serves `script-src 'self'`, so every
      // script must be a file — the layout's short view-transition delegation
      // script included. Zero disables the inlining.
      assetsInlineLimit: 0,
    },
    // No assetFileNames override: assets are content-hashed like everything else.
    //
    // This used to force the name "style.css" onto every CSS asset so that
    // /{PREFIX}/style.css was a fixed path. Nothing needs a fixed path: forcing
    // a constant name only made Rollup disambiguate collisions as style.css /
    // style2.css, which the build then had to guess between (#50). Today no
    // page links a stylesheet at all (see `build.inlineStylesheets` above);
    // scripts/build-vite.js publishes dist/style.css from the inline block for
    // anything outside this repository that still refers to it by that path.
  },
});

