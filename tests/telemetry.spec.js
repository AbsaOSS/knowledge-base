import { test, expect } from '@playwright/test';
import { gotoBoundFragment, waitForFragmentReady } from './support/fragment.js';

const records = (page) => page.evaluate(() => window.__kbTelemetryTest.events);
const visits = async (page) => (await records(page)).filter((event) => event.eventType.endsWith('.bi'));

test('forwards one visit per activation and reports shell readiness', async ({ page }) => {
  await gotoBoundFragment(page);
  await expect.poll(async () => (await visits(page)).length).toBe(1);
  await expect.poll(() => page.evaluate(() => window.__kbTelemetryTest.readiness.length)).toBe(1);
  const frame = page.frames().find((candidate) => candidate.name() === 'wf:knowledge-base');
  await frame.evaluate(() => document.dispatchEvent(new Event('astro:page-load')));
  expect(await visits(page)).toHaveLength(1);

  await page.locator('a.kb-card[href="/knowledge-base/user-guide/"]').click();
  await expect.poll(async () => (await visits(page)).length).toBe(2);
  await page.locator('a.kb-masthead-link').filter({ hasText: 'Library' }).click();
  await expect.poll(async () => (await visits(page)).length).toBe(3);
  await page.locator('a.kb-card[href="/knowledge-base/user-guide/"]').click();
  await expect.poll(async () => (await visits(page)).length).toBe(4);
  expect(page.frames().find((candidate) => candidate.name() === 'wf:knowledge-base')).toBe(frame);
  const all = await records(page);
  expect(all.filter((record) => record.eventType.endsWith('.scenario'))).toHaveLength(3);
  for (const record of all) {
    expect(record.metadata).toMatchObject({ application: 'knowledge-base', environment: 'TEST' });
    expect(record.metadata.appVersion).toMatch(/^1\.0\.0\+[a-f0-9]{12}$/);
    expect(record.payload.application).toBe('knowledge-base');
    expect(JSON.stringify(record)).not.toMatch(/pageUrl|pageTitle|document\.title|[?]wf=/);
  }
  await page.locator('#host-nav-home').click();
  await expect.poll(() => page.frames().filter((candidate) => candidate.name() === 'wf:knowledge-base').length).toBe(0);
  await page.locator('#host-nav-kb').click();
  await waitForFragmentReady(page);
  await expect.poll(async () => (await visits(page)).length).toBe(5);
  // The adapter hears exactly one outcome per page activation, never a duplicate.
  await expect.poll(() => page.evaluate(() => window.__kbTelemetryTest.readiness))
    .toEqual(Array(5).fill('ready'));
});

test('deep links carry only the registered documentation identity', async ({ page }) => {
  await gotoBoundFragment(page, '/knowledge-base/user-guide/');
  await expect.poll(async () => (await visits(page)).length).toBe(1);
  expect((await visits(page))[0].payload).toMatchObject({
    eventName: 'kb-document-opened', metadata: { documentation: 'user-guide', pageKind: 'packaged' },
  });
});

test('shell channel is isolated per tab', async ({ context }) => {
  const first = await context.newPage();
  const second = await context.newPage();
  await gotoBoundFragment(first);
  await gotoBoundFragment(second);
  await expect.poll(async () => (await visits(first)).length).toBe(1);
  await expect.poll(async () => (await visits(second)).length).toBe(1);
  expect(await first.evaluate(() => window.__kbTestShell.channelName))
    .not.toBe(await second.evaluate(() => window.__kbTestShell.channelName));
  await first.close();
  await second.close();
});

for (const mode of ['missing', 'disabled', 'invalid']) {
  test(`${mode} browser configuration preserves navigation and shell readiness`, async ({ page }) => {
    await gotoBoundFragment(page);
    await expect.poll(async () => (await visits(page)).length).toBe(1);
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
    await expect.poll(() => page.frames().filter((frame) => frame.name() === 'wf:knowledge-base').length).toBe(0);
    await page.evaluate(() => {
      window.__kbTelemetryTest.events.length = 0;
      window.__kbTelemetryTest.readiness.length = 0;
    });
    await page.locator('#host-nav-kb').click();
    await waitForFragmentReady(page);
    await expect.poll(() => page.evaluate(() => window.__kbTelemetryTest.readiness.length)).toBe(1);
    expect(await records(page)).toHaveLength(0);
    await page.locator('a.kb-card[href="/knowledge-base/user-guide/"]').click();
    await expect(page.locator('.kb-masthead--compact')).toBeVisible();
    expect(await records(page)).toHaveLength(0);
  });
}
