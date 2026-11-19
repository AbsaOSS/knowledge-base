import { test, expect } from '@playwright/test';
import { gotoBoundFragment, waitForFragmentReady } from './support/fragment.js';

const records = (page) => page.evaluate(() => window.__kbTelemetryTest.events);
const readiness = (page) => page.evaluate(() => window.__kbTelemetryTest.readiness);
const fragmentFrames = (page) => page.frames().filter((frame) => frame.name() === 'wf:knowledge-base');

test('reports shell readiness once per activation and sends no events of its own', async ({ page }) => {
  await gotoBoundFragment(page);
  await expect.poll(() => readiness(page)).toEqual(['ready']);
  const [frame] = fragmentFrames(page);
  await frame.evaluate(() => document.dispatchEvent(new Event('astro:page-load')));

  await page.locator('a.kb-card[href="/knowledge-base/user-guide/"]').click();
  await expect.poll(async () => (await readiness(page)).length).toBe(2);
  await page.locator('a.kb-masthead-link').filter({ hasText: 'Library' }).click();
  await expect.poll(async () => (await readiness(page)).length).toBe(3);
  await page.locator('a.kb-card[href="/knowledge-base/user-guide/"]').click();
  await expect.poll(async () => (await readiness(page)).length).toBe(4);
  expect(fragmentFrames(page)).toEqual([frame]);
  await page.locator('#host-nav-home').click();
  await expect.poll(() => fragmentFrames(page).length).toBe(0);
  await page.locator('#host-nav-kb').click();
  await waitForFragmentReady(page);
  // The adapter hears exactly one outcome per page activation, never a duplicate.
  await expect.poll(() => readiness(page)).toEqual(Array(5).fill('ready'));
  // Forwarding is on, yet the knowledge base records no page views or navigations itself.
  expect(await records(page)).toEqual([]);
});

for (const mode of ['missing', 'disabled', 'invalid']) {
  test(`${mode} browser configuration preserves navigation and shell readiness`, async ({ page }) => {
    await gotoBoundFragment(page);
    await expect.poll(() => readiness(page)).toEqual(['ready']);
    await page.route((url) => /\/(?:__wf\/)?knowledge-base(?:\/|$)/.test(url.pathname), async (route) => {
      if (route.request().resourceType() !== 'fetch') return route.continue();
      // The gateway selects wf-* output using the browser's Sec-Fetch headers.
      const response = await route.fetch({
        headers: {
          ...await route.request().allHeaders(),
          'sec-fetch-dest': 'empty',
          'sec-fetch-mode': 'cors',
          'sec-fetch-site': 'same-origin',
        },
      });
      if (!response.headers()['content-type']?.includes('text/html')) {
        return route.fulfill({ response });
      }
      const html = await response.text();
      const body = html.replace(/<meta name="kb-telemetry" content="[^"]*"\s*\/?>/, (meta) => {
        if (mode === 'missing') return '';
        if (mode === 'invalid') return '<meta name="kb-telemetry" content="{invalid">';
        return meta.replace('&quot;enabled&quot;:true', '&quot;enabled&quot;:false');
      });
      expect(body).not.toBe(html);
      await route.fulfill({ response, body });
    });
    await page.locator('#host-nav-home').click();
    await expect.poll(() => fragmentFrames(page).length).toBe(0);
    await page.evaluate(() => { window.__kbTelemetryTest.readiness.length = 0; });
    await page.locator('#host-nav-kb').click();
    await waitForFragmentReady(page);
    await expect.poll(() => readiness(page)).toEqual(['ready']);
    await page.locator('a.kb-card[href="/knowledge-base/user-guide/"]').click();
    await expect(page.locator('.kb-masthead--compact')).toBeVisible();
    await expect.poll(() => readiness(page)).toEqual(['ready', 'ready']);
  });
}
