// A minimal static file server for local play and development.
//
//   node tools/serve.mjs [port]
//
// ES modules need to be served over http rather than opened from the file
// system, so some server is required. This one exists rather than reaching for
// a dependency, and it sends `Cache-Control: no-store` so an edit is visible on
// the next reload instead of the browser quietly serving a stale module.

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = normalize(join(fileURLToPath(new URL('.', import.meta.url)), '..'));
const PORT = Number(process.argv[2]) || 8123;
const HOST = process.env.HOST || '127.0.0.1';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.mjs':  'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.ico':  'image/x-icon',
  '.woff2': 'font/woff2',
  '.map':  'application/json; charset=utf-8',
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    let pathname = decodeURIComponent(url.pathname);
    if (pathname.endsWith('/')) pathname += 'index.html';

    // Resolve inside the project root and refuse anything that escapes it.
    const filePath = normalize(join(ROOT, pathname));
    if (!filePath.startsWith(ROOT + sep) && filePath !== ROOT) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Forbidden');
      return;
    }

    const info = await stat(filePath);
    if (info.isDirectory()) {
      res.writeHead(302, { Location: pathname + '/' });
      res.end();
      return;
    }

    const body = await readFile(filePath);
    res.writeHead(200, {
      'Content-Type': TYPES[extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Content-Length': body.length,
      // Never cache: a stale module after an edit is the single most confusing
      // failure mode when developing against a live reload.
      'Cache-Control': 'no-store, must-revalidate',
      // IndexedDB, WebGL and the rest need a normal secure-ish context; these
      // just keep the console quiet about referrers to the tile services.
      'Referrer-Policy': 'strict-origin-when-cross-origin',
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch (err) {
    const code = err.code === 'ENOENT' ? 404 : 500;
    res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(code === 404 ? 'Not found' : `Server error: ${err.message}`);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Terra Ambulate is being served from ${ROOT}`);
  console.log(`Open  http://${HOST}:${PORT}`);
});
