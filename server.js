import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleApi } from './server/api.js';
import { store } from './server/store.js';
import { resumePending } from './server/engine.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.join(ROOT, 'web');
const PORT = Number(process.env.PORT) || 4321;
const HOST = process.env.HOST || '127.0.0.1';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'X-Frame-Options': 'SAMEORIGIN',
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; font-src 'self' data:; base-uri 'none'; form-action 'self'",
};

function sendStatic(res, filePath, status = 200) {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return false;
    const ext = path.extname(filePath).toLowerCase();
    const headers = {
      ...SECURITY_HEADERS,
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': stat.size,
      // Source assets revalidate every load so a restarted workspace never serves stale UI.
      'Cache-Control': ['.html', '.js', '.css', '.json'].includes(ext)
        ? 'no-cache'
        : 'public, max-age=300, must-revalidate',
    };
    res.writeHead(status, headers);
    if (res.req?.method === 'HEAD') {
      res.end();
    } else {
      fs.createReadStream(filePath).pipe(res);
    }
    return true;
  } catch {
    return false;
  }
}

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  let url;
  try {
    url = new URL(req.url || '/', `http://${req.headers.host || `${HOST}:${PORT}`}`);
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('Bad request');
    return;
  }

  try {
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url);
      return;
    }

    let pathname = decodeURIComponent(url.pathname);
    if (pathname === '/' || pathname === '') pathname = '/index.html';
    const candidate = path.join(WEB_DIR, pathname);
    const normalized = path.resolve(candidate);
    if (!normalized.startsWith(path.resolve(WEB_DIR))) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Forbidden');
      return;
    }

    if (fs.existsSync(normalized) && sendStatic(res, normalized)) return;

    // Single-page app fallback for extension-less routes.
    if (!path.extname(pathname)) {
      if (sendStatic(res, path.join(WEB_DIR, 'index.html'))) return;
    }

    res.writeHead(404, { ...SECURITY_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  } catch (error) {
    console.error(`[http] ${req.method} ${url.pathname} failed:`, error);
    if (!res.headersSent) {
      res.writeHead(500, { ...SECURITY_HEADERS, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unexpected server error.' }));
    } else {
      try {
        res.end();
      } catch {
        /* closed */
      }
    }
  } finally {
    const elapsed = Date.now() - started;
    if (elapsed > 1500) console.warn(`[slow] ${req.method} ${url.pathname} took ${elapsed}ms`);
  }
});

if (!store.isSeeded()) {
  console.log('[faxline] seeding demo workspace…');
  store.resetDemo();
}

resumePending();

server.listen(PORT, HOST, () => {
  const provider = process.env.FAX_PROVIDER || 'simulator';
  console.log('');
  console.log('  Faxline is running');
  console.log(`  → http://${HOST}:${PORT}`);
  console.log(`  provider: ${provider}   database: data/faxline.db`);
  console.log('');
});

function shutdown(signal) {
  console.log(`\n[faxline] ${signal} received, closing listener…`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
