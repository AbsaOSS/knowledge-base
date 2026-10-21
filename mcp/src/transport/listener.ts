// The sidecar's HTTP listener: /mcp, a health check, and browser-friendly 404s.
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { sendBrowserError } from './error-page.ts';
import type { HttpHandler } from './http.ts';

export function createListener(handler: HttpHandler): Server {
  return createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (path === '/healthz' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
      res.end('ok\n');
      return;
    }
    if (path !== '/mcp') {
      if (req.method === 'GET' || req.method === 'HEAD') {
        sendBrowserError(req, res, 404);
      } else {
        res.statusCode = 404;
        res.end();
      }
      return;
    }
    handler(req, res).catch(() => {
      if (!res.headersSent) res.statusCode = 500;
      if (!res.writableEnded) res.end();
    });
  });
}
