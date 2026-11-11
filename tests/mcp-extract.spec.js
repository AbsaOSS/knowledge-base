import { test, expect } from '@playwright/test';
import { extractDocument } from '../mcp/build/extract.ts';

test('MCP extraction keeps main content and strips untrusted page chrome', () => {
  const result = extractDocument(`<!doctype html><title>Ignored</title><nav>AquaSec decoy</nav><main><h1 id="safe">AquaSec suppress</h1><p>Configure a suppression report from trusted settings.</p><pre class="language-js">const safe = true;</pre><script>alert(1)</script><img alt="diagram" onerror="bad()"></main>`, { fallbackTitle: 'Fallback' });
  expect(result.title).toBe('AquaSec suppress');
  expect(result.text).toContain('# AquaSec suppress');
  expect(result.text).toContain('```js');
  expect(result.text).toContain('[diagram]');
  expect(result.text).not.toContain('AquaSec decoy');
  expect(result.text).not.toContain('alert(1)');
  expect(result.sections).toEqual([{ heading: 'AquaSec suppress', anchor: 'safe', level: 1, start: 0, end: result.text.length }]);
});

test('MCP extraction keeps structure inside wrapper divs and sections', () => {
  const result = extractDocument('<main><div class="md-content"><article><section><h2 id="setup">Setup</h2><p>First paragraph.</p><p>Second paragraph.</p><ul><li>One<ul><li>Nested</li></ul></li><li>Two</li></ul><table><tr><th>Key</th><th>Value</th></tr><tr><td>a</td><td><p>b</p></td></tr></table></section></article></div></main>');
  expect(result.text).toBe('## Setup\n\nFirst paragraph.\n\nSecond paragraph.\n\n- One\n  - Nested\n- Two\n\n| Key | Value |\n| a | b |');
  expect(result.sections.map((section) => section.heading)).toEqual(['Setup']);
});

test('MCP extraction keeps spaces between inline runs and separates text from headings', () => {
  const result = extractDocument('<main><h2>Setup</h2>Run <a href="#">the tool</a> <strong>now</strong>.<div>Then <code>exit</code>.</div></main>');
  expect(result.text).toBe('## Setup\n\nRun the tool now.\n\nThen `exit`.');
});

test('MCP extraction keeps code whitespace and highlighter tokens intact', () => {
  const result = extractDocument('<main><pre class="language-yaml"><code><span class="k">root</span><span>:</span>\n  <span class="k">child</span><span>:</span> <span>1</span>\n</code></pre><pre><code><span>foo</span><span>.</span><span>bar</span>()</code></pre></main>');
  expect(result.text).toBe('```yaml\nroot:\n  child: 1\n```\n\n```\nfoo.bar()\n```');
});
