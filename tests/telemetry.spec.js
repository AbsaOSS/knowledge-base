import { test, expect } from '@playwright/test';
import { gotoBoundFragment, waitForFragmentReady } from './support/fragment.js';

const records = (page) => page.evaluate(() => window.__kbTelemetryTest.events);
const readiness = (page) => page.evaluate(() => window.__kbTelemetryTest.readiness);
const fragmentFrames = (page) => page.frames().filter((frame) => frame.name() === 'wf:knowledge-base');

test('reports shell readiness once per activation and records no page views of its own', async ({ page }) => {
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
  expect((await records(page)).filter((record) => record.payload?.eventName !== 'kb-app-card-clicked' &&
    record.payload?.scenarioName !== 'kb-page-open')).toEqual([]);
});

test.describe('Opening a page', () => {
  const pageOpens = async (page) => (await records(page))
    .filter((record) => record.payload?.scenarioName === 'kb-page-open')
    .map((record) => record.payload);
  const outcomes = async (page) => (await pageOpens(page))
    .map(({ status, reason, metadata }) => [status, reason ?? null, metadata?.app ?? null]);
  const fetchOf = (slug) => (url) => url.pathname.endsWith(`/knowledge-base/${slug}/`);
  const holdFetch = async (page, slug) => {
    const held = [];
    await page.route(fetchOf(slug), (route) => {
      if (route.request().resourceType() !== 'fetch') return route.continue();
      held.push(route);
    });
    return held;
  };

  test.beforeEach(async ({ page }) => {
    await gotoBoundFragment(page);
    await expect.poll(() => readiness(page)).toEqual(['ready']);
  });

  test('records each page opened with its app, route template and steps', async ({ page }) => {
    await page.locator('a.kb-card[href="/knowledge-base/user-guide/"]').click();
    await expect.poll(async () => (await pageOpens(page)).length).toBe(1);
    await page.locator('a.kb-masthead-link').filter({ hasText: 'Library' }).click();
    await expect.poll(async () => (await pageOpens(page)).length).toBe(2);

    const [doc, library] = await pageOpens(page);
    expect(doc).toMatchObject({ status: 'success', route: '/knowledge-base/:app/*', metadata: { app: 'user-guide' } });
    expect(doc.steps.map((step) => step.name)).toEqual(expect.arrayContaining(['fetch', 'render']));
    expect(library).toMatchObject({ status: 'success', route: '/knowledge-base/' });
    expect(library.metadata?.app).toBeUndefined();
  });

  test('an answer Astro cannot use records a browser fallback', async ({ page }) => {
    const received = [];
    await page.exposeFunction('__kbTelemetryRecord', (record) => received.push(record));
    await page.route(fetchOf('user-guide'), (route) => route.request().resourceType() === 'fetch'
      ? route.fulfill({ status: 200, contentType: 'text/plain', body: 'not a page' })
      : route.continue());
    await page.locator('a.kb-card[href="/knowledge-base/user-guide/"]').click();
    await expect.poll(() => received
      .filter(({ payload }) => payload.scenarioName === 'kb-page-open')
      .map(({ payload }) => [payload.status, payload.reason]))
      .toEqual([['incomplete', 'browser-fallback']]);
  });

  test('a second click before the page arrives abandons the first', async ({ page }) => {
    const held = await holdFetch(page, 'user-guide');
    await page.locator('a.kb-card[href="/knowledge-base/user-guide/"]').click();
    await expect.poll(() => held.length).toBe(1);
    await page.locator('a.kb-card[href="/knowledge-base/guide-mirror/"]').click();
    await expect.poll(() => outcomes(page)).toEqual([
      ['abandoned', 'superseded', null],
      ['success', null, 'guide-mirror'],
    ]);
  });
});

test.describe('Library card clicks', () => {
  const cardClicks = async (page) => (await records(page))
    .filter((record) => record.payload?.eventName === 'kb-app-card-clicked');

  test('each click records the app it opens, once, also after the Library was swapped back in', async ({ page }) => {
    await gotoBoundFragment(page);
    await expect.poll(() => readiness(page)).toEqual(['ready']);
    await page.locator('a.kb-card[href="/knowledge-base/user-guide/"]').click();
    await expect.poll(async () => (await cardClicks(page)).length).toBe(1);
    await page.locator('a.kb-masthead-link').filter({ hasText: 'Library' }).click();
    await page.locator('a.kb-card[href="/knowledge-base/guide-mirror/"]').click();
    await expect.poll(async () => (await cardClicks(page)).length).toBe(2);
    await expect(page.locator('.kb-masthead--compact')).toBeVisible();

    const [first, second] = await cardClicks(page);
    expect(first).toMatchObject({
      eventType: 'com.kb-test.bi',
      payload: { application: 'knowledge-base', metadata: { app: 'user-guide' } },
    });
    expect(second.payload.metadata).toEqual({ app: 'guide-mirror' });
  });

  test('a deep link and masthead links record no card click', async ({ page }) => {
    await gotoBoundFragment(page, '/knowledge-base/user-guide/');
    await expect.poll(() => readiness(page)).toEqual(['ready']);
    await page.locator('a.kb-masthead-link').filter({ hasText: 'Library' }).click();
    await expect.poll(() => readiness(page)).toEqual(['ready', 'ready']);
    expect(await cardClicks(page)).toEqual([]);
  });
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
