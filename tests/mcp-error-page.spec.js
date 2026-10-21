import { test, expect } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderErrorPage } from '../mcp/src/transport/error-page.ts';

test('MCP browser error pages describe unavailable routes and unsupported methods', () => {
  const notFound = renderErrorPage(404);
  expect(notFound).toContain('<title>404 — Not available | Knowledge Base</title>');
  expect(notFound).toContain('This MCP route is not available.');
  expect(notFound).toContain('aria-labelledby="error-title"');
  expect(notFound).not.toContain('<script');

  const method = renderErrorPage(405);
  expect(method).toContain('<title>405 — MCP client required | Knowledge Base</title>');
  expect(method).toContain('This endpoint accepts POST requests');
  expect(method).toContain('/knowledge-base/mcp');

  const site = renderErrorPage(404, 'site');
  expect(site).toContain('<title>404 — Page not found | Knowledge Base</title>');
  expect(site).toContain('This page is not available.');
});

test('the build publishes the page nginx serves for every 404', () => {
  const file = join(process.cwd(), 'dist', '_error', 'not-found.html');
  expect(existsSync(file)).toBe(true);
  expect(readFileSync(file, 'utf8')).toBe(renderErrorPage(404, 'site'));
});

test('public MCP subpaths serve designed 404 pages', async ({ request }) => {
  const response = await request.get('/knowledge-base/mcp/not-a-route');
  expect(response.status()).toBe(404);
  expect(response.headers()['content-type']).toContain('text/html');
  expect(await response.text()).toContain('This MCP route is not available.');
});

test('all nginx-mirrored missing routes serve shared 404 page', async ({ playwright }) => {
  const fragment = await playwright.request.newContext({ baseURL: 'http://localhost:3000' });
  try {
    for (const path of ['/not-a-route', '/knowledge-base/not-a-route', '/__wf/knowledge-base/not-a-route', '/knowledge-base/_mcp/search-index.json']) {
      const response = await fragment.get(path);
      expect(response.status(), path).toBe(404);
      expect(response.headers()['content-type'], path).toContain('text/html');
      expect(await response.text(), path).toContain('This page is not available.');
    }
  } finally {
    await fragment.dispose();
  }
});
