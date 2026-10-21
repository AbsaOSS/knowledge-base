import type { IncomingMessage, ServerResponse } from 'node:http';

type PageKind = 404 | 405 | 'site';

const pages: Record<PageKind, { title: string; message: string }> = {
  404: {
    title: 'Not available',
    message: 'This MCP route is not available. Check endpoint address, then try again.',
  },
  405: {
    title: 'MCP client required',
    message: 'This endpoint accepts POST requests from a compatible MCP client.',
  },
  // nginx's error_page for every other missing route; the build writes it to dist/_error/not-found.html.
  site: {
    title: 'Page not found',
    message: 'This page is not available. Check the address, or go back to the <a href="/knowledge-base/">Library</a>.',
  },
};

/** Render browser-only HTTP errors without changing MCP JSON-RPC responses. */
export function renderErrorPage(status: number, kind: PageKind = status === 405 ? 405 : 404): string {
  const page = pages[kind];
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex">
  <title>${status} — ${page.title} | Knowledge Base</title>
  <style>
    :root { color-scheme: light; font-family: Inter, Arial, sans-serif; }
    * { box-sizing: border-box; }
    body { min-width: 320px; min-height: 100vh; margin: 0; background: #fff7f8; color: #131010; }
    main { display: grid; min-height: 100vh; padding: 40px 24px; place-items: center; }
    .notice { width: min(100%, 540px); padding: 32px; border: 1px solid #e5e7eb; border-radius: 16px; background: #fff; box-shadow: 0 4px 12px rgb(19 16 16 / 12%); text-align: center; }
    .icon { display: inline-grid; width: 48px; height: 48px; margin-bottom: 20px; place-items: center; border-radius: 12px; background: #fbedf0; color: #77021e; }
    h1 { margin: 0; font-size: 18px; font-weight: 700; letter-spacing: -.01em; line-height: 1.4; }
    p { max-width: 420px; margin: 8px auto 0; color: #5b616e; font-size: 14px; line-height: 1.6; }
    a { color: #77021e; }
    code { padding: 2px 4px; border-radius: 4px; background: #f3f4f6; color: #3c0714; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .9em; }
  </style>
</head>
<body>
  <main aria-labelledby="error-title">
    <section class="notice" aria-live="polite">
      <div class="icon" aria-hidden="true">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="10" width="16" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>
      </div>
      <h1 id="error-title">${page.title}</h1>
      <p>${page.message}</p>
      ${status === 405 ? '<p>Configure your client to use <code>/knowledge-base/mcp</code>.</p>' : ''}
    </section>
  </main>
</body>
</html>`;
}

export function sendBrowserError(req: IncomingMessage, res: ServerResponse, status: 404 | 405): void {
  const html = renderErrorPage(status);
  res.statusCode = status;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Length', Buffer.byteLength(html));
  res.end(req.method === 'HEAD' ? undefined : html);
}
