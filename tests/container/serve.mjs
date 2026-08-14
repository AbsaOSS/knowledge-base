/**
 * tests/container/serve.mjs
 *
 * Builds and runs the production runtime image, for Playwright's `webServer` to
 * drive. Used by playwright.config.docker.js.
 *
 * WHY A REAL CONTAINER
 *
 * tests/fragment-server.mjs is a hand-written Express mirror of the nginx
 * rewrites. It is what the other two suites run against, and it is only as
 * faithful as the last person to remember to update both — which is how #45
 * (every location block silently dropping the inherited headers) and #60 (the
 * mirror sending a 308 where nginx does an internal rewrite) both survived. This
 * suite asserts the routing and header contract against the actual nginx.conf,
 * in the actual image, so drift is caught rather than assumed absent.
 *
 * Deliberately NOT part of `npm test`: that suite is hermetic and Docker-free,
 * and `docker build` pulls a base image. This runs in the CI job that already
 * builds the image, so it costs no extra build.
 *
 * Env:
 *   KB_IMAGE           image tag to run     (default knowledge-base:container-test)
 *   KB_SKIP_BUILD      skip `docker build`  (set in CI, where the image exists)
 *   KB_CONTAINER_PORT  host port            (default 8099)
 */

import { spawn, spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const IMAGE = process.env.KB_IMAGE || 'knowledge-base:container-test';
const PORT = process.env.KB_CONTAINER_PORT || '8099';
const NAME = 'kb-container-test';

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (res.error) throw res.error;
  return res.status;
}

/** Best-effort removal — a stale container from a killed run must not block this one. */
function removeContainer() {
  spawnSync('docker', ['rm', '-f', NAME], { stdio: 'ignore' });
}

if (run('docker', ['version', '--format', '{{.Server.Version}}'], { stdio: 'ignore' }) !== 0) {
  console.error('✗ Docker is not available — this suite needs it. Run `npm test` for the Docker-free suites.');
  process.exit(1);
}

if (!process.env.KB_SKIP_BUILD) {
  console.log(`▶ building ${IMAGE}…`);
  // Fails fast and loudly when dist/ is missing: the Dockerfile checks for it.
  if (run('docker', ['build', '-t', IMAGE, '.'], { cwd: ROOT }) !== 0) {
    console.error('✗ docker build failed — did you run `npm run build:headless` first?');
    process.exit(1);
  }
}

removeContainer();

console.log(`▶ knowledge-base container → http://localhost:${PORT}/knowledge-base/`);
const child = spawn(
  'docker',
  ['run', '--rm', '--name', NAME, '-p', `${PORT}:8080`, IMAGE],
  { stdio: 'inherit' },
);

// Playwright terminates this process on teardown. `docker run --rm` usually
// cleans up on its own, but a hard kill can orphan the container, so the removal
// is repeated here rather than relied upon.
const shutdown = () => { removeContainer(); process.exit(0); };
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.on('exit', removeContainer);

child.on('exit', (code) => { removeContainer(); process.exit(code ?? 0); });
