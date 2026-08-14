/**
 * tests/transform.spec.js
 *
 * Unit tests for src/utils/transform.js — the one place third-party HTML is
 * rewritten and split before Base.astro re-hosts it.
 *
 * These run against the function, not the built site, because the interesting
 * inputs are the ones no fixture app happens to ship: a `</body>` inside a
 * script, a `<` inside the theme bootstrap, a code sample in the prose that
 * merely *looks* like markup. Each case below is a way the previous regex
 * implementation silently produced a broken page (#48).
 */

import { test, expect } from '@playwright/test';
import { transformSubAppHtml, isThemeBootstrap } from '../src/utils/transform.js';

const PREFIX = 'knowledge-base';
const SLUG = 'demo';

/** Transforms a document as if it were apps/demo/{dir}/index.html. */
const run = (html, dir = '') => transformSubAppHtml(html, SLUG, dir, PREFIX);

/** Wraps body markup in a minimal document. */
const doc = (body, head = '') => `<!DOCTYPE html><html><head><title>T</title>${head}</head><body>${body}</body></html>`;

test.describe('document splitting', () => {
  test('a </body> inside a script does not truncate the page', () => {
    const { bodyHtml } = run(doc(
      '<p id="before">before</p>' +
      '<script>var end = "</body></html>";</script>' +
      '<p id="after">after</p>',
    ));
    expect(bodyHtml).toContain('id="before"');
    expect(bodyHtml, 'everything after the literal </body> was dropped').toContain('id="after"');
  });

  test('a </head> inside a comment does not truncate the head', () => {
    const { headHtml } = run(doc('<p>x</p>', '<!-- </head> --><meta name="generator" content="demo">'));
    expect(headHtml).toContain('name="generator"');
  });

  test('a document with no <body> is still split, not mistaken for a fragment', () => {
    const { headHtml, bodyHtml } = run('<title>T</title><link rel="canonical" href="/c"><p id="loose">x</p>');
    expect(headHtml).toContain('rel="canonical"');
    expect(bodyHtml).toContain('id="loose"');
  });

  test('the title is lifted and the layout duplicates are dropped', () => {
    const { title, headHtml } = run(doc('<p>x</p>', '<meta charset="utf-8"><meta name="viewport" content="width=device-width">'));
    expect(title).toBe('T');
    expect(headHtml).not.toContain('<title');
    expect(headHtml).not.toContain('charset');
    expect(headHtml).not.toContain('viewport');
  });

  test('the body class survives, minus `dark`', () => {
    expect(run('<html><body class="docs dark theme-x"><p>x</p></body></html>').bodyClass)
      .toBe('docs theme-x');
  });
});

test.describe('light-only enforcement', () => {
  const BOOTSTRAP =
    "<script>for(let i=0;i<1;i++){if(localStorage.getItem('theme')==='dark')" +
    "document.documentElement.classList.add('dark')}</script>";

  test('the theme bootstrap is stripped even when it contains a `<`', () => {
    const { bodyHtml } = run(doc(BOOTSTRAP + '<p id="keep">x</p>'));
    expect(bodyHtml, 'the bootstrap would re-add `dark` at runtime').not.toContain('localStorage');
    expect(bodyHtml).toContain('id="keep"');
  });

  test('it is stripped from the head too', () => {
    expect(run(doc('<p>x</p>', BOOTSTRAP)).headHtml).not.toContain('localStorage');
  });

  test('an unrelated localStorage script is left alone', () => {
    const script = "<script>localStorage.setItem('sidebar','open')</script>";
    expect(isThemeBootstrap("localStorage.setItem('sidebar','open')")).toBe(false);
    expect(run(doc(script)).bodyHtml).toContain('localStorage');
  });
});

test.describe('URL rewriting', () => {
  test('rewrites the single-URL attributes', () => {
    const { bodyHtml } = run(doc(
      '<a href="page/">a</a>' +
      '<img src="/img/logo.png">' +
      '<form action="search"><button formaction="/submit">go</button></form>' +
      '<video poster="poster.jpg"></video>' +
      '<object data="/model.svg"></object>',
    ), 'docs');
    expect(bodyHtml).toContain('href="/knowledge-base/demo/docs/page/"');
    expect(bodyHtml).toContain('src="/knowledge-base/demo/img/logo.png"');
    expect(bodyHtml).toContain('action="/knowledge-base/demo/docs/search"');
    expect(bodyHtml).toContain('formaction="/knowledge-base/demo/submit"');
    expect(bodyHtml).toContain('poster="/knowledge-base/demo/docs/poster.jpg"');
    expect(bodyHtml).toContain('data="/knowledge-base/demo/model.svg"');
  });

  test('rewrites srcset candidates, keeping their descriptors', () => {
    const { bodyHtml, headHtml } = run(doc(
      '<img src="a.png" srcset="a.png 1x, /b/a@2x.png 2x">',
      '<link rel="preload" as="image" href="/hero.png" imagesrcset="/hero.png 1x">',
    ), 'docs');
    expect(bodyHtml).toContain('srcset="/knowledge-base/demo/docs/a.png 1x, /knowledge-base/demo/b/a@2x.png 2x"');
    expect(headHtml).toContain('imagesrcset="/knowledge-base/demo/hero.png 1x"');
  });

  test('rewrites url() in inline styles and <style> blocks', () => {
    const { bodyHtml, headHtml } = run(doc(
      '<div style="background:url(/bg.png) no-repeat"></div>',
      "<style>.hero{background-image:url('img/hero.png')}</style>",
    ), 'docs');
    expect(bodyHtml).toContain('url(/knowledge-base/demo/bg.png)');
    expect(headHtml).toContain("url('/knowledge-base/demo/docs/img/hero.png')");
  });

  test('rewrites URL-bearing meta content', () => {
    const { headHtml } = run(doc('<p>x</p>', '<meta property="og:image" content="/card.png"><meta name="description" content="/not-a-url">'));
    expect(headHtml).toContain('content="/knowledge-base/demo/card.png"');
    expect(headHtml).toContain('content="/not-a-url"');
  });

  test('leaves external, anchor and data URLs alone', () => {
    const { bodyHtml } = run(doc(
      '<a href="https://example.com/x">e</a>' +
      '<a href="#top">t</a>' +
      '<a href="mailto:x@y.z">m</a>' +
      '<a href="//cdn.example.com/x">p</a>' +
      '<img src="data:image/gif;base64,R0lGOD">',
    ));
    expect(bodyHtml).toContain('href="https://example.com/x"');
    expect(bodyHtml).toContain('href="#top"');
    expect(bodyHtml).toContain('href="mailto:x@y.z"');
    expect(bodyHtml).toContain('href="//cdn.example.com/x"');
    expect(bodyHtml).toContain('src="data:image/gif;base64,R0lGOD"');
  });

  test('does not rewrite markup quoted in prose or comments', () => {
    const { bodyHtml } = run(doc(
      '<pre><code>&lt;a href="/docs/api"&gt;API&lt;/a&gt;</code></pre>' +
      '<!-- <a href="/docs/api">API</a> -->',
    ));
    expect(bodyHtml, 'a code sample is text, not a link').not.toContain('/knowledge-base/demo/docs/api');
    expect(bodyHtml).toContain('href="/docs/api"');
  });

  test('removes <base>, which would re-resolve every rewritten URL', () => {
    const { headHtml } = run(doc('<p>x</p>', '<base href="/some/root/">'));
    expect(headHtml).not.toContain('<base');
  });

  test('stamps stylesheet links so ClientRouter keeps them across transitions', () => {
    const { headHtml } = run(doc('<p>x</p>', '<link rel="stylesheet" href="style.css">'), 'docs');
    expect(headHtml).toContain('href="/knowledge-base/demo/docs/style.css"');
    expect(headHtml).toContain('data-astro-transition-persist="css-knowledge-base-demo-docs-style-css"');
  });
});
