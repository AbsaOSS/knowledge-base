/**
 * release.cjs — attaches kb-docs.tar.gz to a GitHub Release and notifies a
 * deployment, through the REST API only.
 *
 * Both action.yml files run this from an `actions/github-script` step, which
 * brings its own Node runtime and an authenticated Octokit client. That is the
 * whole point: the runner needs no `gh` CLI, no preinstalled toolchain and no
 * network access beyond the GitHub API, so the actions run on self-hosted
 * runners exactly as they do on GitHub-hosted ones (#85).
 *
 * CommonJS in an ESM package on purpose. github-script hands the script a
 * `require`, and a `.cjs` file is what that loads without leaning on Node's
 * require(esm) support. The module has no dependencies for the same reason: it
 * runs under github-script's Node, not under the tree `npm ci` installed.
 *
 * Everything consumer-controlled arrives through `env`, never interpolated into
 * the script body — the same rule the shell steps follow (#55).
 */
'use strict';

const { readFileSync } = require('node:fs');
const { basename } = require('node:path');

const ASSET_NAME = 'kb-docs.tar.gz';
const DISPATCH_EVENT = 'kb-docs-published';

/** The HTTP status of a failed Octokit request, or undefined for anything else. */
const statusOf = (err) => (err && typeof err.status === 'number' ? err.status : undefined);

/**
 * Resolves the release the artifact goes on.
 *
 * With `tag`: that release. `getReleaseByTag` only sees published releases, so
 * a draft — a release workflow that has not flipped the switch yet — is found
 * by scanning the list instead, the way `gh release upload` would.
 *
 * Without: the latest published release, then the most recently created
 * release of any kind (`/releases/latest` excludes drafts and pre-releases),
 * then null.
 */
async function resolveRelease({ github, owner, repo, tag }) {
  if (tag) {
    try {
      const { data } = await github.rest.repos.getReleaseByTag({ owner, repo, tag });
      return data;
    } catch (err) {
      if (statusOf(err) !== 404) throw err;
    }
    const { data: releases } = await github.rest.repos.listReleases({ owner, repo, per_page: 100 });
    return releases.find((release) => release.tag_name === tag) || null;
  }

  try {
    const { data } = await github.rest.repos.getLatestRelease({ owner, repo });
    return data;
  } catch (err) {
    if (statusOf(err) !== 404) throw err;
  }
  const { data: releases } = await github.rest.repos.listReleases({ owner, repo, per_page: 1 });
  return releases[0] || null;
}

/**
 * Uploads `file` to `release`, replacing an asset of the same name — the
 * `--clobber` an idempotent re-run needs.
 *
 * The upload goes to the release's own `upload_url` rather than to the API
 * host: on GitHub Enterprise the two are different origins, and a hard-coded
 * uploads.github.com would be one more thing the runner's environment has to
 * look like.
 */
async function uploadAsset({ github, core, owner, repo, release, file }) {
  const name = basename(file);
  const existing = (release.assets || []).find((asset) => asset.name === name);
  if (existing) {
    core.info(`Replacing the existing ${name} on ${release.tag_name}.`);
    await github.rest.repos.deleteReleaseAsset({ owner, repo, asset_id: existing.id });
  }

  const data = readFileSync(file);
  // upload_url is a URI template: …/releases/1/assets{?name,label}
  const url = `${release.upload_url.replace(/\{[^}]*\}$/, '')}?name=${encodeURIComponent(name)}`;
  const { data: asset } = await github.request({
    method: 'POST',
    url,
    headers: { 'content-type': 'application/gzip', 'content-length': data.length },
    data,
  });
  return asset;
}

/**
 * The upload step. Reads KB_RELEASE_TAG, KB_ARTIFACT, KB_COUNT and KB_SLUGS
 * from `env`; sets the `release-tag` output and writes the step summary.
 * `noun` is what the summary counts: "app" for publish-docs, "doc" for
 * publish-single-page-docs.
 */
async function publish({ github, core, context, env, noun = 'app' }) {
  const { owner, repo } = context.repo;
  const full = `${owner}/${repo}`;
  const file = env.KB_ARTIFACT;
  if (!file) throw new Error('KB_ARTIFACT is not set: the build step produced no artifact path.');

  const tag = (env.KB_RELEASE_TAG || '').trim();
  const release = await resolveRelease({ github, owner, repo, tag });
  if (!release) {
    throw new Error(
      tag
        ? `${full} has no release tagged '${tag}'. Create it and re-run, or pass a different release-tag.`
        : `${full} has no GitHub Release to attach the docs artifact to. Create a release (any tag) and re-run, or pass release-tag explicitly.`
    );
  }

  core.info(`Uploading ${basename(file)} to release ${release.tag_name} (replacing any existing asset)…`);
  const asset = await uploadAsset({ github, core, owner, repo, release, file });
  core.info(`Uploaded ${asset.name} (${asset.size} bytes).`);

  core.setOutput('release-tag', release.tag_name);
  await core.summary.addRaw(`Published ${env.KB_COUNT} ${noun}(s): ${env.KB_SLUGS}`, true).write();
  return release.tag_name;
}

/**
 * The notify step. Fires `kb-docs-published` at KB_NOTIFY_REPO with the
 * publishing repo, tag and slugs as the payload. Never throws: the artifact is
 * already on the release, and the deployment's schedule will pick it up, so a
 * failed notify is a warning on a successful publish.
 */
async function notify({ github, core, context, env }) {
  const target = (env.KB_NOTIFY_REPO || '').trim();
  const [owner, repo, ...rest] = target.split('/');
  if (!owner || !repo || rest.length) {
    core.warning(`notify-repo must be 'owner/name', got '${target}'. Nothing was notified.`);
    return false;
  }

  const source = `${context.repo.owner}/${context.repo.repo}`;
  try {
    await github.rest.repos.createDispatchEvent({
      owner,
      repo,
      event_type: DISPATCH_EVENT,
      client_payload: { repo: source, tag: env.KB_RELEASE_TAG, slugs: env.KB_SLUGS },
    });
    core.info(`Notified ${target}.`);
    return true;
  } catch (err) {
    core.warning(
      `Could not notify ${target} (${err.message}). The artifact was published; the deployment will pick it up on its next scheduled build.`
    );
    return false;
  }
}

module.exports = { ASSET_NAME, DISPATCH_EVENT, resolveRelease, uploadAsset, publish, notify };
