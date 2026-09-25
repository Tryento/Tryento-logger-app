/**
 * serve.mjs — local static server for development and verification.
 *
 * The app cannot run from file:// — it uses ES modules, a dynamic import, and
 * a service worker, all of which browsers block on that scheme. Service
 * workers also require a secure context, which localhost counts as.
 */
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { existsSync } from 'node:fs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Serve exactly what Netlify would serve. Serving the repo root instead would
// quietly let a missing dist/ entry "work" locally and 404 in production.
const ROOT = existsSync(path.join(REPO, 'dist')) ? path.join(REPO, 'dist') : REPO;
const PORT = Number(process.argv[2] || process.env.PORT || 8137);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.md': 'text/markdown; charset=utf-8',
  '.sql': 'text/plain; charset=utf-8'
};

const server = http.createServer(async (req, res) => {
  let rel = decodeURIComponent(req.url.split('?')[0]);
  if (rel === '/') rel = '/index.html';

  const file = path.join(ROOT, rel);
  if (!path.normalize(file).startsWith(ROOT)) {
    res.writeHead(403).end('forbidden');
    return;
  }

  try {
    const info = await stat(file);
    if (info.isDirectory()) throw new Error('directory');
    const body = await readFile(file);
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'Content-Type': TYPES[ext] || 'application/octet-stream',
      // Never cache during development, or the service worker and the browser
      // will serve yesterday's build and you will debug a ghost.
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Service-Worker-Allowed': '/'
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('no encontrado');
  }
});

server.listen(PORT, () => {
  console.log(`TryEnto sirviendo en http://localhost:${PORT}/`);
  console.log(`  raíz: ${ROOT}`);
});
