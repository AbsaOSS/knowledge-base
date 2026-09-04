/**
 * tests/artifact-safety.spec.js
 *
 * Unit tests for scripts/artifacts.js — the extraction guard that stands between
 * an onboarding repo's release tarball and this repository's filesystem.
 *
 * Release artifacts come from other repositories, so they are untrusted input. A
 * tarball that escapes its extraction root, or that smuggles in a symlink the
 * later HTML crawl would follow, must be refused with a message naming the
 * offending member — not extracted and dealt with afterwards.
 *
 * The fixtures are written byte-by-byte rather than produced with `tar`, because
 * a traversal member is exactly what `tar` refuses to *create*, and because it
 * keeps the test identical on GNU tar and the bsdtar shipped in Windows.
 */

import { test, expect } from '@playwright/test';
import { gzipSync } from 'node:zlib';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { extractTarball, copyDir } from '../scripts/artifacts.js';

const BLOCK = 512;

/** Writes a NUL-padded field into a header block. */
function field(block, offset, length, value) {
  Buffer.from(String(value)).copy(block, offset, 0, Math.min(length - 1, Buffer.byteLength(String(value))));
}

/**
 * Builds one 512-byte ustar header.
 *
 * @param {string} name     - member name as stored in the archive
 * @param {number} size     - content length in bytes
 * @param {string} typeflag - '0' regular file, '2' symlink, '5' directory
 * @param {string} linkname - target, for symlinks
 */
function header(name, size, typeflag = '0', linkname = '') {
  const block = Buffer.alloc(BLOCK, 0);
  field(block, 0, 100, name);
  field(block, 100, 8, '0000644');
  field(block, 108, 8, '0000000');
  field(block, 116, 8, '0000000');
  field(block, 124, 12, size.toString(8).padStart(11, '0'));
  field(block, 136, 12, '00000000000');
  // typeflag is exactly one byte with no NUL terminator — written directly
  // rather than through field(), whose padding would consume the only slot.
  block[156] = typeflag.charCodeAt(0);
  field(block, 157, 100, linkname);
  field(block, 257, 6, 'ustar');
  block.write('00', 263, 2, 'ascii');

  // Checksum is computed with the checksum field itself read as eight spaces.
  block.fill(0x20, 148, 156);
  let sum = 0;
  for (const byte of block) sum += byte;
  field(block, 148, 8, sum.toString(8).padStart(6, '0'));
  block[154] = 0;
  block[155] = 0x20;
  return block;
}

/** Packs `entries` into a gzipped tar and writes it to `outPath`. */
function writeTarball(outPath, entries) {
  const blocks = [];
  for (const entry of entries) {
    const content = Buffer.from(entry.content ?? '');
    blocks.push(header(entry.name, entry.typeflag === '2' ? 0 : content.length, entry.typeflag ?? '0', entry.linkname ?? ''));
    if (entry.typeflag !== '2' && content.length > 0) {
      const padded = Buffer.alloc(Math.ceil(content.length / BLOCK) * BLOCK, 0);
      content.copy(padded);
      blocks.push(padded);
    }
  }
  blocks.push(Buffer.alloc(BLOCK * 2, 0)); // end-of-archive marker
  writeFileSync(outPath, gzipSync(Buffer.concat(blocks)));
}

let workDir;

test.beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'kb-artifact-safety-'));
});

test.afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

test.describe('extractTarball', () => {
  test('extracts a well-formed bundle', () => {
    const tar = join(workDir, 'dist.tar.gz');
    writeTarball(tar, [
      { name: 'bundle.json', content: '{"marketplaceVersion":"1"}' },
      { name: 'my-doc/index.html', content: '<html data-kb-headless="true"></html>' },
    ]);

    const dest = join(workDir, 'out');
    extractTarball(tar, dest, 'good-bundle');

    expect(readFileSync(join(dest, 'bundle.json'), 'utf8')).toContain('marketplaceVersion');
    expect(readFileSync(join(dest, 'my-doc', 'index.html'), 'utf8')).toContain('data-kb-headless');
  });

  test('refuses a member that escapes the root via ".."', () => {
    const tar = join(workDir, 'evil.tar.gz');
    writeTarball(tar, [
      { name: 'index.html', content: 'ok' },
      { name: '../../pwned.txt', content: 'escaped' },
    ]);

    const dest = join(workDir, 'out');
    expect(() => extractTarball(tar, dest, 'evil-repo'))
      .toThrow(/evil-repo.*escapes the archive root/s);

    // Nothing may have been written outside — the guard runs before extraction.
    expect(existsSync(join(workDir, 'pwned.txt'))).toBe(false);
    expect(existsSync(join(dest, 'index.html'))).toBe(false);
  });

  test('refuses an absolute member', () => {
    const tar = join(workDir, 'abs.tar.gz');
    writeTarball(tar, [{ name: '/etc/cron.d/pwned', content: 'x' }]);

    expect(() => extractTarball(tar, join(workDir, 'out'), 'abs-repo'))
      .toThrow(/abs-repo.*absolute path/s);
  });

  test('refuses a symlink member', () => {
    const tar = join(workDir, 'link.tar.gz');
    writeTarball(tar, [
      { name: 'index.html', content: 'ok' },
      { name: 'secrets.html', typeflag: '2', linkname: '/etc/passwd' },
    ]);

    // The traversal check passes (the name is innocuous); the post-extraction
    // lstat walk is what catches this one.
    expect(() => extractTarball(tar, join(workDir, 'out'), 'link-repo'))
      .toThrow(/link-repo.*symlink/s);
  });

  test('refuses an empty archive', () => {
    const tar = join(workDir, 'empty.tar.gz');
    writeTarball(tar, []);

    expect(() => extractTarball(tar, join(workDir, 'out'), 'empty-repo'))
      .toThrow(/empty-repo.*empty/s);
  });
});

test.describe('copyDir', () => {
  test('copies a tree without shelling out to cp', () => {
    const src = join(workDir, 'src');
    mkdirSync(join(src, 'nested'), { recursive: true });
    writeFileSync(join(src, 'a.txt'), 'a');
    writeFileSync(join(src, 'nested', 'b.txt'), 'b');

    const dest = join(workDir, 'dest');
    copyDir(src, dest);

    expect(readFileSync(join(dest, 'a.txt'), 'utf8')).toBe('a');
    expect(readFileSync(join(dest, 'nested', 'b.txt'), 'utf8')).toBe('b');
  });
});
