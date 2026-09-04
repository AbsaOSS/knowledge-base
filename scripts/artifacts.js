/**
 * artifacts.js — safe extraction and copying of sub-app artifacts.
 *
 * Every artifact this build consumes is a `kb-docs.tar.gz` produced by *another*
 * repository's release pipeline, so its contents are untrusted input: a
 * compromised (or merely careless) doc repo must not be able to write outside
 * the staging directory, and must not be able to smuggle a symlink into the
 * published site.
 *
 * Both onboarding paths share this module — scripts/fetch-apps.js (GitHub
 * releases) and scripts/build-vite.js (`prebuilt`/`localPath`) — so the two
 * cannot drift on the safety checks the way they previously drifted on
 * portability.
 */

import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

/** Forward slashes — GNU tar in git-bash rejects backslash-separated -C targets. */
const posix = (p) => p.replace(/\\/g, '/');

/**
 * Rejects an archive member that would escape the extraction root.
 *
 * tar itself strips a leading `/` and GNU tar refuses `..` members, but that is
 * a defence we neither control nor can rely on across GNU tar and the bsdtar
 * shipped in Windows System32. Checking the listing first makes the guarantee
 * ours and produces an error naming the offending entry.
 */
function assertNoTraversal(entries, label) {
  for (const entry of entries) {
    const name = entry.replace(/\\/g, '/');
    if (name.startsWith('/')) {
      throw new Error(`${label}: archive member "${entry}" is an absolute path — refusing to extract.`);
    }
    if (/^[a-z]:/i.test(name)) {
      throw new Error(`${label}: archive member "${entry}" carries a drive letter — refusing to extract.`);
    }
    if (name.split('/').includes('..')) {
      throw new Error(`${label}: archive member "${entry}" escapes the archive root via ".." — refusing to extract.`);
    }
  }
}

/**
 * Rejects link members declared in the archive.
 *
 * A symlink that survived into apps/ would be followed later by the HTML crawl
 * and the asset copy, which is how a doc artifact could publish a file from
 * outside its own tree — a CI secret, say.
 *
 * This reads the *declaration* rather than the extracted result because the two
 * differ by platform: Windows silently drops symlink members when the process
 * lacks the create-symlink privilege, so a post-extraction check alone would
 * pass on a developer machine and only fail on Linux CI. GNU tar and bsdtar
 * disagree about the rest of the verbose line, but both start it with the mode
 * string, whose first character is `l` for a symlink and `h` for a hardlink.
 */
function assertNoLinkMembers(verboseListing, label) {
  for (const line of verboseListing.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const type = trimmed[0];
    if (type === 'l' || type === 'h') {
      throw new Error(
        `${label}: archive declares a ${type === 'l' ? 'symlink' : 'hardlink'} member ` +
        `(${trimmed}) — refusing to use it. Doc artifacts must contain regular files only.`,
      );
    }
  }
}

/**
 * Rejects symlinks anywhere under `dir`, after extraction.
 *
 * Belt and braces with assertNoLinkMembers: `lstat` behaves the same everywhere
 * and catches anything the listing parse missed.
 */
function assertNoSymlinks(dir, label, root = dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(
        `${label}: archive contains a symlink at "${posix(full.slice(root.length + 1))}" — ` +
        `refusing to use it. Doc artifacts must contain regular files only.`,
      );
    }
    if (entry.isDirectory()) assertNoSymlinks(full, label, root);
  }
}

/**
 * Extracts a .tar.gz into `destDir`, validating it first.
 *
 * Portability: GNU tar (git-bash) parses a leading "C:" in the ARCHIVE name as a
 * remote host, so the command runs from the tarball's own directory and passes
 * only its basename to -f. The -C target is not parsed that way, it just needs
 * forward slashes. This avoids --force-local, which bsdtar rejects.
 *
 * @param {string} tarPath - path to the .tar.gz
 * @param {string} destDir - directory to extract into (created if absent)
 * @param {string} label   - human-readable origin, used in error messages
 */
export function extractTarball(tarPath, destDir, label) {
  mkdirSync(destDir, { recursive: true });

  const cwd = dirname(tarPath);
  const name = basename(tarPath);

  const opts = { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] };
  const entries = execFileSync('tar', ['-tzf', name], opts)
    .split('\n').map((l) => l.trim()).filter(Boolean);
  if (entries.length === 0) throw new Error(`${label}: archive is empty.`);
  assertNoTraversal(entries, label);
  assertNoLinkMembers(execFileSync('tar', ['-tvzf', name], opts), label);

  execFileSync('tar', ['-xzf', name, '-C', posix(destDir)], { cwd, stdio: 'pipe' });
  assertNoSymlinks(destDir, label);
}

/**
 * Materialises a local artifact into a staging directory.
 *
 * The artifact may be a `.tar.gz` tarball (as published to GitHub Releases) or a
 * directory. Tarballs are extracted under `stageRoot/{name}`; directories are
 * used in place.
 */
export function stageArtifact(srcPath, name, stageRoot, label = name) {
  if (!lstatSync(srcPath).isFile()) return srcPath;

  const stageDir = join(stageRoot, name);
  if (existsSync(stageDir)) rmSync(stageDir, { recursive: true });
  extractTarball(srcPath, stageDir, label);
  return stageDir;
}

/**
 * Recursively copies a directory tree, skipping symlinks.
 *
 * Replaces the `cp -r` this build used to shell out to, which does not exist on
 * Windows outside a POSIX shell. `readdirSync(withFileTypes)` also avoids a
 * `statSync` syscall per entry, and reports symlinks without following them.
 */
export function copyDir(src, dest) {
  mkdirSync(dest, { recursive: true });
  const entries = readdirSync(src, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1));
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const srcPath = join(src, entry.name);
    const destPath = join(dest, entry.name);
    if (entry.isDirectory()) copyDir(srcPath, destPath);
    else if (entry.isFile()) copyFileSync(srcPath, destPath);
  }
}
