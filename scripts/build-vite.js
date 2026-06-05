/**
 * build-vite.js — knowledge-base build orchestrator
 *
 * Usage:
 *   node scripts/build-vite.js           (downloads Release artifacts via GitHub API)
 *   node scripts/build-vite.js --local   (builds each app from local source)
 *   node scripts/build-vite.js --headless
 *
 * Pipeline:
 *   1. Fetch/build sub-app artifacts → apps/{slug}/
 *   2. Copy non-HTML sub-app assets → public/knowledge-base/{slug}/
 *      (Astro serves these as static files; HTML files are handled by the catchall page)
 *   3. Run astro build → dist/
 *      Sub-app pages are rendered by src/pages/[...path].astro via getStaticPaths.
 */

import { existsSync, readFileSync, mkdirSync, rmSync, copyFileSync, readdirSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';
import { execSync } from 'child_process';
import { fetchApps } from './fetch-apps.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const APPS_DIR = join(ROOT, 'apps');

const LOCAL_MODE  = process.argv.includes('--local');
const HEADLESS    = process.argv.includes('--headless') || process.env.MP_HEADLESS === 'true';
const prefixArg   = process.argv.find(a => a.startsWith('--path-prefix='));
const PATH_PREFIX = prefixArg ? prefixArg.split('=').slice(1).join('=') : 'knowledge-base';

const log  = (msg) => console.log('\x1b[36m→\x1b[0m ' + msg);
const ok   = (msg) => console.log('\x1b[32m✓\x1b[0m ' + msg);
const warn = (msg) => console.warn('\x1b[33m⚠\x1b[0m  ' + msg);
const step = (msg) => console.log('\n\x1b[1m' + msg + '\x1b[0m');

function copyDir(src, dest) {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src).sort()) {
    const srcPath  = join(src, entry);
    const destPath = join(dest, entry);
    if (statSync(srcPath).isDirectory()) copyDir(srcPath, destPath);
    else copyFileSync(srcPath, destPath);
  }
}

async function build() {
  const startMs = Date.now();
  const modeLabel = [LOCAL_MODE && 'local', HEADLESS && 'headless'].filter(Boolean).join(', ');
  console.log('\n\x1b[1m\x1b[35m▶ knowledge-base build' + (modeLabel ? ' (' + modeLabel + ')' : '') + '\x1b[0m\n');

  const registeredApps = JSON.parse(readFileSync(join(ROOT, 'apps.json'), 'utf8'));

  // 1. Prepare apps/ directory
  step('1/3  Preparing sub-app artifacts → apps/');
  mkdirSync(APPS_DIR, { recursive: true });

  if (LOCAL_MODE) {
    for (const app of registeredApps) {
      if (!app.localPath) { warn(app.slug + ': no localPath, skipping'); continue; }
      const srcDir = app.localPath.replace(/^~/, homedir());
      const buildScript = HEADLESS ? 'build:headless' : 'build';
      log('Building ' + app.slug + ' from ' + app.localPath + '…');
      execSync('npm run ' + buildScript, { cwd: srcDir, stdio: 'inherit' });

      const srcDist = join(srcDir, 'dist');
      const destDir = join(APPS_DIR, app.slug);
      if (existsSync(destDir)) rmSync(destDir, { recursive: true });
      copyDir(srcDist, destDir);
      const manifest = join(srcDir, 'marketplace.json');
      if (existsSync(manifest)) copyFileSync(manifest, join(destDir, 'marketplace.json'));
      ok(app.slug + ' ready (local)');
    }
  } else {
    await fetchApps(registeredApps);
  }

  // 2. Copy non-HTML sub-app assets → public/{slug}/ so Astro copies them to dist/{slug}/
  //    HTML files are excluded — they're handled by src/pages/[...path].astro.
  step('2/4  Copying sub-app assets → public/');
  const PUBLIC_ROOT = join(ROOT, 'public');
  mkdirSync(PUBLIC_ROOT, { recursive: true });

  // Clean only known slug dirs so user-owned public/ files (favicon, robots.txt…) are preserved
  for (const app of registeredApps) {
    const slugDir = join(PUBLIC_ROOT, app.slug);
    if (existsSync(slugDir)) rmSync(slugDir, { recursive: true });
  }

  function copyAssets(src, dest) {
    mkdirSync(dest, { recursive: true });
    for (const entry of readdirSync(src).sort()) {
      const s = join(src, entry);
      const d = join(dest, entry);
      if (statSync(s).isDirectory()) copyAssets(s, d);
      else if (!entry.endsWith('.html')) copyFileSync(s, d);
    }
  }

  for (const app of registeredApps) {
    const srcDir = join(APPS_DIR, app.slug);
    if (!existsSync(srcDir)) { warn(app.slug + ': apps/ dir missing, skipping asset copy'); continue; }
    copyAssets(srcDir, join(PUBLIC_ROOT, app.slug));
    ok(app.slug + ' assets → public/' + app.slug + '/');
  }

  // 3. Run Astro build
  step('3/4  Running astro build');
  const env = {
    ...process.env,
    MP_PREFIX:   PATH_PREFIX,
    MP_HEADLESS: HEADLESS ? 'true' : 'false',
  };
  execSync('npx astro build', { cwd: ROOT, stdio: 'inherit', env });
  ok('Astro build complete');

  // 4. Summary
  step('4/4  Build complete');
  const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
  const slugs = readdirSync(APPS_DIR).filter(d => statSync(join(APPS_DIR, d)).isDirectory());
  const appList = slugs.map(s => '    \u2022 \x1b[36m' + s + '\x1b[0m → dist/' + s + '/').join('\n');
  console.log('\n\x1b[32m✓\x1b[0m \x1b[1m' + slugs.length + ' app(s) integrated\x1b[0m in ' + elapsed + 's\n\n  Apps:\n' + appList + '\n  Prefix: \x1b[33m' + PATH_PREFIX + '\x1b[0m\n');
}

build().catch(err => {
  console.error('\n\x1b[31m✗ Build failed:\x1b[0m', err.message);
  process.exit(1);
});
