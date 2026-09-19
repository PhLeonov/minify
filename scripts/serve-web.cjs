// Локальный сервер готовой PWA. localhost разрешает Service Worker без HTTPS.
// Для доступа с iPhone используйте HTTPS-хостинг; localhost телефона — сам телефон.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../build/web');
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.wasm': 'application/wasm', '.webmanifest': 'application/manifest+json', '.png': 'image/png' };
const base = process.env.MINIFY_BASE || '/';
const port = Number(process.env.MINIFY_PORT || 4179);
http.createServer((req, res) => {
  let pathname;
  try { pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); }
  catch { res.writeHead(400); res.end(); return; }
  if (!pathname.startsWith(base)) { res.writeHead(404); res.end(); return; }
  const relative = pathname.slice(base.length);
  const file = path.resolve(root, relative || 'index.html');
  if (!file.startsWith(root + path.sep)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (error, bytes) => {
    if (error) { res.writeHead(404); res.end(); return; }
    res.setHeader('Content-Type', types[path.extname(file)] || 'application/octet-stream');
    for (const line of fs.readFileSync(path.join(root, '_headers'), 'utf8').split(/\r?\n\r?\n/)[0].split(/\r?\n/).slice(1)) {
      const colon = line.indexOf(':');
      if (colon > 0) res.setHeader(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
    }
    res.setHeader('Cache-Control', 'no-cache');
    res.end(bytes);
  });
}).listen(port, '127.0.0.1', () => console.log(`PWA: http://localhost:${port}${base}`));
