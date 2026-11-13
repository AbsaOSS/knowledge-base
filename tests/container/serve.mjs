/**
 * tests/container/serve.mjs
 *
 * Builds and runs the production runtime images, for Playwright's `webServer` to
 * drive. Used by playwright.config.docker.js.
 *
 * Two containers, wired the way a deployment's task runs them: the MCP server
 * image (mcp-server/Dockerfile) owns the network namespace and the published
 * port, and nginx joins it (`--network container:`), so nginx reaches the MCP
 * server on 127.0.0.1:8081 exactly as it does in a shared-namespace task. nginx
 * starts only once the MCP container reports healthy — the deployment's
 * `dependsOn: HEALTHY`.
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
 *   KB_MCP_IMAGE       MCP image tag        (default knowledge-base-mcp:container-test)
 *   KB_SKIP_BUILD      skip `docker build`  (set in CI, where the images exist)
 *   KB_CONTAINER_PORT  host port            (default 8099)
 */

import { spawn, spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const IMAGE = process.env.KB_IMAGE || 'knowledge-base:container-test';
const MCP_IMAGE = process.env.KB_MCP_IMAGE || 'knowledge-base-mcp:container-test';
const PORT = process.env.KB_CONTAINER_PORT || '8099';
const NAME = 'kb-container-test';
const MCP_NAME = 'kb-container-test-mcp';
const HEALTHY_WITHIN_MS = 60_000;

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (res.error) throw res.error;
  return res.status;
}

/** Best-effort removal — a stale container from a killed run must not block this one. */
function removeContainers() {
  spawnSync('docker', ['rm', '-f', NAME, MCP_NAME], { stdio: 'ignore' });
}

function healthOf(name) {
  const res = spawnSync('docker', ['inspect', '--format', '{{.State.Health.Status}}', name], { encoding: 'utf8' });
  return res.stdout.trim();
}

/** The image's own HEALTHCHECK decides, polled faster than its production interval. */
async function waitUntilHealthy(name) {
  const deadline = Date.now() + HEALTHY_WITHIN_MS;
  while (Date.now() < deadline) {
    const status = healthOf(name);
    if (status === 'healthy') return true;
    if (status === 'unhealthy' || status === '') return false;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

if (run('docker', ['version', '--format', '{{.Server.Version}}'], { stdio: 'ignore' }) !== 0) {
  console.error('✗ Docker is not available — this suite needs it. Run `npm test` for the Docker-free suites.');
  process.exit(1);
}

if (!process.env.KB_SKIP_BUILD) {
  for (const [image, dockerfile] of [[IMAGE, 'Dockerfile'], [MCP_IMAGE, 'mcp-server/Dockerfile']]) {
    console.log(`▶ building ${image}…`);
    // Fails fast and loudly when dist/ is missing: both Dockerfiles check for it.
    if (run('docker', ['build', '-f', dockerfile, '-t', image, '.'], { cwd: ROOT }) !== 0) {
      console.error('✗ docker build failed — did you run `npm run build:headless` first?');
      process.exit(1);
    }
  }
}

removeContainers();

console.log(`▶ MCP server container (${MCP_NAME})`);
const mcpStarted = run('docker', [
  'run', '--detach', '--name', MCP_NAME,
  '-p', `${PORT}:8080`,
  '--health-interval', '1s', '--health-start-period', '30s',
  '--env', `KB_MCP_PUBLIC_ORIGIN=http://localhost:${PORT}`,
  '--env', `KB_MCP_ALLOWED_ORIGINS=http://localhost:${PORT}`,
  MCP_IMAGE,
]);
if (mcpStarted !== 0 || !(await waitUntilHealthy(MCP_NAME))) {
  console.error(`✗ the MCP container did not become healthy (${healthOf(MCP_NAME) || 'not running'})`);
  run('docker', ['logs', MCP_NAME]);
  removeContainers();
  process.exit(1);
}

console.log(`▶ knowledge-base container → http://localhost:${PORT}/knowledge-base/`);
const child = spawn(
  'docker',
  ['run', '--rm', '--name', NAME, '--network', `container:${MCP_NAME}`, IMAGE],
  { stdio: 'inherit' },
);

// Playwright terminates this process on teardown. `docker run --rm` usually
// cleans up on its own, but a hard kill can orphan the container, so the removal
// is repeated here rather than relied upon.
const shutdown = () => { removeContainers(); process.exit(0); };
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.on('exit', removeContainers);

child.on('exit', (code) => { removeContainers(); process.exit(code ?? 0); });
