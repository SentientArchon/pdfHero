// Dev/test server: serves public/ exactly as GitHub Pages will. All PDF work happens in the browser.
import http from 'node:http';
import fs from 'node:fs/promises';
import { existsSync, createReadStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const PORT = Number(process.env.PORT || 4321);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm', '.json': 'application/json', '.png': 'image/png', '.gz': 'application/gzip', '.bcmap': 'application/octet-stream', '.pfb': 'application/octet-stream', '.ttf': 'font/ttf', '.icc': 'application/vnd.iccprofile' };

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  let file = path.join(ROOT, decodeURIComponent(url.pathname));
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); } // no ../ escapes
  if (existsSync(file) && (await fs.stat(file)).isDirectory()) file = path.join(file, 'index.html');
  if (!existsSync(file)) { res.writeHead(404); return res.end('Not found'); }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  createReadStream(file).pipe(res);
}).listen(PORT, '127.0.0.1', () => console.log(`pdfHero dev server at http://127.0.0.1:${PORT}`));
