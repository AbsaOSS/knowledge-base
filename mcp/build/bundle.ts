// Bundles the server into one minified, dependency-free ESM file for the image.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import type { Metafile, Plugin } from 'esbuild';

const MCP_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * zod (classic API and core) re-exports every locale as `z.locales`, and the namespace import keeps
 * all of them: 258 KB minified, for error messages the server only ever renders in English.
 */
const englishOnlyZodLocales: Plugin = {
  name: 'zod-english-only',
  setup(context) {
    context.onResolve({ filter: /^\.\.\/locales\/index\.js$/ }, (args) =>
      /[\\/]zod[\\/]v4[\\/](?:classic|core)[\\/]/.test(args.importer)
        ? { path: join(dirname(args.importer), '..', 'locales', 'index.js'), namespace: 'zod-locales' }
        : undefined,
    );
    context.onLoad({ filter: /.*/, namespace: 'zod-locales' }, (args) => ({
      contents: `export { default as en } from ${JSON.stringify(join(dirname(args.path), 'en.js'))};`,
      loader: 'js',
      resolveDir: dirname(args.path),
    }));
  },
};

/** Build `mcp/src/main.ts` into `outfile`; returns the esbuild metafile. */
export async function bundleServer(outfile: string): Promise<Metafile> {
  const result = await build({
    entryPoints: [join(MCP_ROOT, 'src', 'main.ts')],
    outfile,
    bundle: true,
    packages: 'bundle',
    platform: 'node',
    format: 'esm',
    target: 'node24',
    minify: true,
    legalComments: 'none',
    metafile: true,
    alias: { '@modelcontextprotocol/server/_shims': join(MCP_ROOT, 'src', 'sdk-shims.ts') },
    plugins: [englishOnlyZodLocales],
  });
  return result.metafile;
}
