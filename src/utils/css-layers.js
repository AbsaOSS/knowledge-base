// src/utils/css-layers.js
//
// The cascade-layer contract between the knowledge base's own CSS and the CSS
// of the documentation apps it re-hosts. Shared by the build (which rewrites
// every copied sub-app stylesheet), transform.js (which rewrites inline
// <style> blocks) and Base.astro (which declares the order in every <head>).
//
// WHY LAYERS
//
// Inside a web fragment the knowledge base's head is managed by reframed, and
// reframed does not reliably remove a previous page's <link>/<style> when the
// ClientRouter navigates (web-fragments issue #297, and the swap in
// src/scripts/embedded-transitions.js exists because of it). Whenever that
// fails, a documentation app's stylesheet outlives its page: the landing
// catalog is then rendered under a docs theme's `h1 {…}`, `a {…}`, `nav {…}`,
// and the masthead on the next app wears two themes at once.
//
// Cascade layers make that harmless instead of impossible. Every sub-app
// stylesheet is wrapped in the `kb-app` layer, which sits BELOW the knowledge
// base's own rules and its Tailwind utilities, so a leaked rule can never beat
// a knowledge base rule for the same property — regardless of specificity or
// source order. And the `kb-reset` layer, declared just above it, holds a fence
// (see knowledge-base.css) that resets every property of the knowledge base's
// own regions back to the browser default, so a leaked rule cannot even fill a
// gap the knowledge base left unstyled.
//
// The order also keeps the one thing the previous `@layer base;` fix protected:
// Tailwind's Preflight (`base`) stays below every sub-app stylesheet, so a docs
// theme's heading sizes are never clobbered by Preflight's `h1 { font-size:
// inherit }`. Layer order is fixed by the FIRST statement that names the
// layers, which is why the same statement is emitted in the layout's <head>
// AND at the top of every rewritten sub-app stylesheet: whichever the browser
// parses first, the order is the same.

/** The layer every documentation app's CSS is wrapped in. */
export const SUB_APP_LAYER = 'kb-app';

/** The layer holding the fence around the knowledge base's own regions. */
export const SHELL_LAYER = 'kb-reset';

/** The one order statement, lowest priority first. */
export const LAYER_ORDER = `@layer theme, base, ${SUB_APP_LAYER}, ${SHELL_LAYER}, components, utilities;`;

/**
 * Rewrites an `@import` so the imported sheet lands inside the sub-app layer:
 * a named layer is nested (`layer(x)` → `layer(kb-app.x)`), an anonymous one is
 * named, and a plain import gets the layer. The layer clause has to sit right
 * after the URL, ahead of any supports()/media conditions.
 */
function layerImport(target, rest) {
  let tail = rest.trim();
  if (/\blayer\s*\(/.test(tail)) {
    tail = tail.replace(/\blayer\s*\(\s*([^)]*?)\s*\)/, `layer(${SUB_APP_LAYER}.$1)`);
  } else if (/(^|\s)layer(\s|$)/.test(tail)) {
    tail = tail.replace(/(^|\s)layer(?=\s|$)/, `$1layer(${SUB_APP_LAYER})`);
  } else {
    tail = `layer(${SUB_APP_LAYER})${tail ? ' ' + tail : ''}`;
  }
  return `@import ${target} ${tail};`;
}

/**
 * Wraps a documentation app's stylesheet in the `kb-app` cascade layer.
 *
 * `@charset` and `@import` are only valid ahead of every other rule and are
 * not allowed inside a block, so the leading prelude is consumed first: the
 * charset is dropped (every asset is served as UTF-8) and each import is
 * hoisted, itself layered. An `@import` that appears later in the file is
 * already ignored by browsers and stays where it is, so wrapping does not
 * activate it. Everything else — `@font-face`, `@media`, `@keyframes`,
 * `@property`, the app's own `@layer`s — is valid inside a layer block and is
 * left untouched.
 *
 * Idempotent: a sheet that already starts with the order statement is returned
 * as is, so re-running the build over an already-rewritten copy is safe.
 */
export function layerSubAppCss(css) {
  let body = css.replace(/^﻿/, '');
  if (body.startsWith(LAYER_ORDER)) return body;

  const imports = [];
  const prelude = /\s+|\/\*[\s\S]*?\*\/|@charset\s+"[^"]*"\s*;|@import\s+(url\(\s*(?:"[^"]*"|'[^']*'|[^)]*)\s*\)|"[^"]*"|'[^']*')([^;]*);/giy;
  let at = 0;
  for (;;) {
    prelude.lastIndex = at;
    const m = prelude.exec(body);
    if (!m) break;
    if (m[1] !== undefined) imports.push(layerImport(m[1], m[2] ?? ''));
    at = prelude.lastIndex;
  }
  body = body.slice(at);

  return [
    LAYER_ORDER,
    ...imports,
    `@layer ${SUB_APP_LAYER}{`,
    body.trim(),
    '}',
    '',
  ].join('\n');
}
