/**
 * release.selftest.js — `npm run selftest:release` inside actions/.
 *
 * Exercises lib/release.cjs — the release upload and the notify both actions
 * run through actions/github-script — against a recording fake of the Octokit
 * client and of `core`. No network, no runner: the point is to pin which API
 * calls are made, in which order, and what a consumer sees when a release is
 * missing, so that dropping the gh CLI (#85) did not change the behaviour a
 * docs repo already relies on.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { ASSET_NAME, DISPATCH_EVENT, publish, notify } = require('./release.cjs');

const root = mkdtempSync(join(tmpdir(), 'kb-release-'));
const artifact = join(root, ASSET_NAME);
writeFileSync(artifact, 'not really gzip, but bytes');

let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (err) {
    failures++;
    console.log(`  \x1b[31m✗\x1b[0m ${name}\n    ${err.message}`);
  }
}

/** An Octokit error the way @octokit/request throws it. */
function httpError(status) {
  const err = new Error(`HTTP ${status}`);
  err.status = status;
  return err;
}

function release(tag, { id = 1, assets = [], draft = false } = {}) {
  return {
    id,
    tag_name: tag,
    draft,
    assets,
    upload_url: `https://uploads.example.test/repos/acme/docs/releases/${id}/assets{?name,label}`,
  };
}

/**
 * A recording fake of the github-script client. `responses` maps a method name
 * to a value to resolve with or an Error to reject with; every call is logged.
 */
function fakeGithub(responses) {
  const calls = [];
  const method = (name) => async (params) => {
    calls.push({ name, params });
    const r = responses[name];
    if (r instanceof Error) throw r;
    if (typeof r === 'function') return r(params);
    if (r === undefined) throw new Error(`unexpected call to ${name}`);
    return { data: r };
  };
  return {
    calls,
    request: method('request'),
    rest: {
      repos: {
        getReleaseByTag: method('getReleaseByTag'),
        getLatestRelease: method('getLatestRelease'),
        listReleases: method('listReleases'),
        deleteReleaseAsset: method('deleteReleaseAsset'),
        createDispatchEvent: method('createDispatchEvent'),
      },
    },
  };
}

function fakeCore() {
  const core = { infos: [], warnings: [], outputs: {}, summaryText: '' };
  core.info = (m) => core.infos.push(m);
  core.warning = (m) => core.warnings.push(m);
  core.setOutput = (k, v) => { core.outputs[k] = v; };
  core.summary = {
    addRaw(text, eol) { core.summaryText += text + (eol ? '\n' : ''); return this; },
    async write() { core.summaryWritten = true; },
  };
  return core;
}

const context = { repo: { owner: 'acme', repo: 'docs' } };
const env = { KB_ARTIFACT: artifact, KB_COUNT: '2', KB_SLUGS: 'a,b' };

console.log('\nrelease.cjs — publish');

await check('an explicit tag resolves through getReleaseByTag and uploads with the asset name', async () => {
  const github = fakeGithub({ getReleaseByTag: release('v1.2.0'), request: { name: ASSET_NAME, size: 26 } });
  const core = fakeCore();
  const tag = await publish({ github, core, context, env: { ...env, KB_RELEASE_TAG: 'v1.2.0' } });

  assert.equal(tag, 'v1.2.0');
  assert.deepEqual(github.calls.map((c) => c.name), ['getReleaseByTag', 'request']);
  assert.deepEqual(github.calls[0].params, { owner: 'acme', repo: 'docs', tag: 'v1.2.0' });

  const upload = github.calls[1].params;
  assert.equal(upload.method, 'POST');
  assert.equal(upload.url, `https://uploads.example.test/repos/acme/docs/releases/1/assets?name=${ASSET_NAME}`);
  assert.equal(upload.headers['content-type'], 'application/gzip');
  assert.equal(upload.headers['content-length'], 26);
  assert.ok(Buffer.isBuffer(upload.data));

  assert.equal(core.outputs['release-tag'], 'v1.2.0');
  assert.equal(core.summaryText, 'Published 2 app(s): a,b\n');
  assert.ok(core.summaryWritten);
});

await check('an existing asset of the same name is deleted first (the --clobber)', async () => {
  const assets = [{ id: 77, name: ASSET_NAME }, { id: 78, name: 'other.zip' }];
  const github = fakeGithub({ getReleaseByTag: release('v1', { assets }), deleteReleaseAsset: {}, request: { name: ASSET_NAME, size: 1 } });
  await publish({ github, core: fakeCore(), context, env: { ...env, KB_RELEASE_TAG: 'v1' } });

  assert.deepEqual(github.calls.map((c) => c.name), ['getReleaseByTag', 'deleteReleaseAsset', 'request']);
  assert.deepEqual(github.calls[1].params, { owner: 'acme', repo: 'docs', asset_id: 77 });
});

await check('a draft release with the given tag is found by scanning the list', async () => {
  const github = fakeGithub({
    getReleaseByTag: httpError(404),
    listReleases: [release('v2.0.0', { id: 5, draft: true }), release('v1.9.0', { id: 4 })],
    request: { name: ASSET_NAME, size: 1 },
  });
  const core = fakeCore();
  await publish({ github, core, context, env: { ...env, KB_RELEASE_TAG: 'v2.0.0' } });

  assert.deepEqual(github.calls.map((c) => c.name), ['getReleaseByTag', 'listReleases', 'request']);
  assert.equal(github.calls[1].params.per_page, 100);
  assert.match(github.calls[2].params.url, /releases\/5\/assets/);
  assert.equal(core.outputs['release-tag'], 'v2.0.0');
});

await check('a tag that matches no release fails naming the tag', async () => {
  const github = fakeGithub({ getReleaseByTag: httpError(404), listReleases: [release('v1')] });
  await assert.rejects(
    publish({ github, core: fakeCore(), context, env: { ...env, KB_RELEASE_TAG: 'v9' } }),
    /acme\/docs has no release tagged 'v9'.*pass a different release-tag/
  );
});

await check('without a tag, the latest published release wins', async () => {
  const github = fakeGithub({ getLatestRelease: release('v3.1.0', { id: 9 }), request: { name: ASSET_NAME, size: 1 } });
  const core = fakeCore();
  await publish({ github, core, context, env: { ...env, KB_RELEASE_TAG: '' }, noun: 'doc' });

  assert.deepEqual(github.calls.map((c) => c.name), ['getLatestRelease', 'request']);
  assert.equal(core.outputs['release-tag'], 'v3.1.0');
  assert.equal(core.summaryText, 'Published 2 doc(s): a,b\n');
});

await check('without a published release, the most recently created one of any kind is used', async () => {
  const github = fakeGithub({
    getLatestRelease: httpError(404),
    listReleases: [release('v0.1.0-rc.1', { id: 2 })],
    request: { name: ASSET_NAME, size: 1 },
  });
  const core = fakeCore();
  await publish({ github, core, context, env });

  assert.deepEqual(github.calls.map((c) => c.name), ['getLatestRelease', 'listReleases', 'request']);
  assert.equal(github.calls[1].params.per_page, 1);
  assert.equal(core.outputs['release-tag'], 'v0.1.0-rc.1');
});

await check('with no release at all, the message says to create one', async () => {
  const github = fakeGithub({ getLatestRelease: httpError(404), listReleases: [] });
  await assert.rejects(
    publish({ github, core: fakeCore(), context, env }),
    /acme\/docs has no GitHub Release.*Create a release \(any tag\) and re-run, or pass release-tag explicitly/
  );
});

await check('an API failure other than 404 is not swallowed', async () => {
  const github = fakeGithub({ getLatestRelease: httpError(403) });
  await assert.rejects(publish({ github, core: fakeCore(), context, env }), /HTTP 403/);
  assert.deepEqual(github.calls.map((c) => c.name), ['getLatestRelease']);
});

await check('a missing artifact path fails before touching the API', async () => {
  const github = fakeGithub({});
  await assert.rejects(
    publish({ github, core: fakeCore(), context, env: { ...env, KB_ARTIFACT: '' } }),
    /KB_ARTIFACT is not set/
  );
  assert.equal(github.calls.length, 0);
});

console.log('\nrelease.cjs — notify');

await check('fires kb-docs-published at the target with repo, tag and slugs', async () => {
  const github = fakeGithub({ createDispatchEvent: {} });
  const core = fakeCore();
  const ok = await notify({ github, core, context, env: { KB_NOTIFY_REPO: 'acme/deployment', KB_RELEASE_TAG: 'v1', KB_SLUGS: 'a,b' } });

  assert.equal(ok, true);
  assert.deepEqual(github.calls[0].params, {
    owner: 'acme',
    repo: 'deployment',
    event_type: DISPATCH_EVENT,
    client_payload: { repo: 'acme/docs', tag: 'v1', slugs: 'a,b' },
  });
  assert.deepEqual(core.warnings, []);
});

await check('a failed dispatch is a warning, never an error', async () => {
  const github = fakeGithub({ createDispatchEvent: httpError(404) });
  const core = fakeCore();
  const ok = await notify({ github, core, context, env: { KB_NOTIFY_REPO: 'acme/deployment', KB_RELEASE_TAG: 'v1', KB_SLUGS: 'a' } });

  assert.equal(ok, false);
  assert.equal(core.warnings.length, 1);
  assert.match(core.warnings[0], /Could not notify acme\/deployment.*next scheduled build/);
});

await check('a malformed notify-repo warns and makes no call', async () => {
  const github = fakeGithub({});
  const core = fakeCore();
  const ok = await notify({ github, core, context, env: { KB_NOTIFY_REPO: 'just-a-name' } });

  assert.equal(ok, false);
  assert.equal(github.calls.length, 0);
  assert.match(core.warnings[0], /notify-repo must be 'owner\/name'/);
});

rmSync(root, { recursive: true, force: true });

if (failures) {
  console.log(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log('\nAll checks passed.');
