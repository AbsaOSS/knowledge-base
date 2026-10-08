import { test, expect } from '@playwright/test';
import { extractDocument } from '../mcp/extract.js';

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
