// pdfHero local server. Binds to 127.0.0.1 only; nothing is stored or sent anywhere.
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import { existsSync, createReadStream } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 4321);
const MAX_BODY = 500 * 1024 * 1024;
process.env.PATH = `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH}`;

const BIN = {
  gs: 'gs',
  qpdf: 'qpdf',
  ocrmypdf: 'ocrmypdf',
  soffice: '/Applications/LibreOffice.app/Contents/MacOS/soffice',
  chrome: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  python: existsSync(path.join(ROOT, '.venv/bin/python')) ? path.join(ROOT, '.venv/bin/python') : 'python3',
};
const PY = path.join(ROOT, 'tools', 'convert.py');

async function has(bin) {
  if (bin.startsWith('/')) return existsSync(bin);
  try { await run('/usr/bin/which', [bin]); return true; } catch { return false; }
}
async function hasPy(mod) {
  try { await run(BIN.python, ['-c', `import ${mod}`]); return true; } catch { return false; }
}

// Each op: which tools it needs, and how to turn in-file -> out-file.
const OPS = {
  compress: { needs: ['gs'], ext: 'pdf', async run(i, o, q) {
    const level = { low: '/printer', recommended: '/ebook', extreme: '/screen' }[q.level] || '/ebook';
    await run(BIN.gs, ['-sDEVICE=pdfwrite', '-dCompatibilityLevel=1.5', `-dPDFSETTINGS=${level}`,
      '-dNOPAUSE', '-dQUIET', '-dBATCH', '-dDetectDuplicateImages=true', `-sOutputFile=${o}`, i]);
  } },
  repair: { needs: ['qpdf', 'gs'], ext: 'pdf', async run(i, o) {
    try { await qpdf([i, o]); } catch {
      await run(BIN.gs, ['-sDEVICE=pdfwrite', '-dNOPAUSE', '-dQUIET', '-dBATCH', `-sOutputFile=${o}`, i]);
    }
  } },
  ocr: { needs: ['ocrmypdf'], ext: 'pdf', async run(i, o, q) {
    const lang = /^[a-z_+]{3,40}$/.test(q.lang || '') ? q.lang : 'eng';
    await run(BIN.ocrmypdf, ['--skip-text', '-l', lang, '--output-type', 'pdf', i, o], { timeout: 30 * 60e3 });
  } },
  pdfa: { needs: ['ocrmypdf'], ext: 'pdf', async run(i, o, q) {
    const type = { '1b': 'pdfa-1', '2b': 'pdfa-2', '3b': 'pdfa-3' }[q.level] || 'pdfa-2';
    await run(BIN.ocrmypdf, ['--skip-text', '--tesseract-timeout', '0', '--output-type', type, i, o], { timeout: 30 * 60e3 });
  } },
  protect: { needs: ['qpdf'], ext: 'pdf', async run(i, o, q, h, dir) {
    const pw = pwd(h['x-password']);
    if (!pw) throw new UserError('A password is required.');
    await qpdf(await argFile(dir, ['--encrypt', pw, pwd(h['x-owner-password']) || pw, '256', '--', i, o]));
  } },
  unlock: { needs: ['qpdf'], ext: 'pdf', async run(i, o, q, h, dir) {
    const args = ['--decrypt', i, o];
    if (h['x-password']) args.unshift(`--password=${pwd(h['x-password'])}`);
    try { await qpdf(await argFile(dir, args)); } catch (e) {
      if (/invalid password/i.test(e.stderr || '')) throw new UserError('Wrong password for this file.');
      throw e;
    }
  } },
  office2pdf: { needs: ['soffice'], ext: 'pdf', input: 'keep', async run(i, o, q, h, dir) {
    await run(BIN.soffice, ['--headless', `-env:UserInstallation=file://${dir}/lo`, '--convert-to', 'pdf', '--outdir', dir, i], { timeout: 10 * 60e3 });
    await fs.rename(path.join(dir, path.parse(i).name + '.pdf'), o);
  } },
  pdf2word: { needs: ['python:pdf2docx'], ext: 'docx', async run(i, o) { await run(BIN.python, [PY, 'word', i, o], { timeout: 30 * 60e3 }); } },
  pdf2excel: { needs: ['python:pdfplumber', 'python:openpyxl'], ext: 'xlsx', async run(i, o) { await run(BIN.python, [PY, 'excel', i, o], { timeout: 30 * 60e3 }); } },
  pdf2ppt: { needs: ['gs', 'python:pptx'], ext: 'pptx', async run(i, o) { await run(BIN.python, [PY, 'ppt', i, o], { timeout: 30 * 60e3 }); } },
  html2pdf: { needs: ['chrome'], ext: 'pdf', input: 'keep', optionalBody: true, async run(i, o, q, h, dir) {
    let target = null;
    if (i) {
      // Untrusted HTML on a file:// origin could pull other local files into the PDF: lock it down.
      const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:">`;
      let html = await fs.readFile(i, 'utf8');
      html = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (m) => m + csp)
        : /<!doctype[^>]*>/i.test(html) ? html.replace(/<!doctype[^>]*>/i, (m) => m + csp) : csp + html;
      await fs.writeFile(i, html);
      target = `file://${i}`; // default-src 'none' also blocks scripts (Chrome's scriptEnabled flag breaks printing)
    }
    if (q.url) {
      const u = new URL(q.url); // throws on garbage
      if (!/^https?:$/.test(u.protocol)) throw new UserError('Only http(s) URLs are allowed.');
      target = u.href;
    }
    if (!target) throw new UserError('Give a URL or an HTML file.');
    await run(BIN.chrome, ['--headless', '--disable-gpu', '--no-pdf-header-footer', `--user-data-dir=${dir}/chrome`,
      '--virtual-time-budget=8000', `--print-to-pdf=${o}`, target], { timeout: 2 * 60e3 });
  } },
};

class UserError extends Error {}
// Passwords arrive URI-encoded so non-ASCII survives HTTP headers.
const pwd = (v) => (v ? decodeURIComponent(v) : '');

// qpdf reads "@file" as one argument per line; keeps passwords out of `ps` output.
async function argFile(dir, args) {
  if (args.some((a) => /[\r\n]/.test(a))) throw new UserError('Passwords cannot contain line breaks.');
  const f = path.join(dir, 'qpdf-args');
  await fs.writeFile(f, args.join('\n') + '\n', { mode: 0o600 });
  return [`@${f}`];
}

async function qpdf(args) {
  try { await run(BIN.qpdf, args); } catch (e) {
    if (e.code === 3) return; // 3 = succeeded with warnings
    throw e;
  }
}

async function health() {
  const tools = {};
  for (const k of ['gs', 'qpdf', 'ocrmypdf', 'soffice', 'chrome']) tools[k] = await has(BIN[k]);
  for (const m of ['pdf2docx', 'pdfplumber', 'openpyxl', 'pptx']) tools[`python:${m}`] = await hasPy(m);
  const ops = {};
  for (const [name, op] of Object.entries(OPS)) ops[name] = op.needs.every((n) => tools[n]);
  let langs = ['eng'];
  if (tools.ocrmypdf) {
    try { langs = (await run('tesseract', ['--list-langs'])).stdout.split('\n').slice(1).filter((l) => l && l !== 'osd'); } catch {}
  }
  return { tools, ops, langs };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on('data', (c) => { n += c.length; if (n > MAX_BODY) { reject(new UserError('File is larger than 500 MB.')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function handleOp(name, req, res, url) {
  const op = OPS[name];
  if (!op) return send(res, 404, 'Unknown tool.');
  const q = Object.fromEntries(url.searchParams);
  const body = await readBody(req);
  if (!body.length && !op.optionalBody) throw new UserError('No file received.');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pdfhero-'));
  try {
    const ext = (path.extname(q.name || '').toLowerCase().replace(/[^.a-z0-9]/g, '') || '.pdf');
    const input = body.length ? path.join(dir, 'input' + ext) : null;
    if (input) await fs.writeFile(input, body);
    const output = path.join(dir, 'output.' + op.ext);
    await op.run(input, output, q, req.headers, dir);
    const stat = await fs.stat(output).catch(() => null);
    if (!stat || !stat.size) throw new Error('The converter produced no output.');
    const data = await fs.readFile(output);
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'X-Ext': op.ext, 'Content-Length': data.length });
    res.end(data);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.wasm': 'application/wasm', '.json': 'application/json', '.png': 'image/png' };
const STATIC = [
  ['/vendor/pdfjs/', path.join(ROOT, 'node_modules/pdfjs-dist/')],
  ['/vendor/pdf-lib.js', path.join(ROOT, 'node_modules/pdf-lib/dist/pdf-lib.esm.min.js')],
  ['/vendor/jszip.js', path.join(ROOT, 'node_modules/jszip/dist/jszip.min.js')],
  ['/', path.join(ROOT, 'public/')],
];
const CSP = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; media-src 'self' blob:; worker-src 'self' blob:; connect-src 'self' blob: data:; font-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

async function serveStatic(res, pathname) {
  for (const [prefix, target] of STATIC) {
    if (!pathname.startsWith(prefix)) continue;
    let file = target.endsWith('/') ? path.join(target, pathname.slice(prefix.length) || 'index.html') : (pathname === prefix ? target : null);
    if (!file || !file.startsWith(target)) continue; // blocks ../ escapes
    if (existsSync(file) && (await fs.stat(file)).isFile()) {
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Content-Security-Policy': CSP, 'Cache-Control': 'no-cache' });
      return createReadStream(file).pipe(res);
    }
  }
  send(res, 404, 'Not found');
}

function send(res, code, text) {
  res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  // Refuse requests from other sites' pages (DNS rebinding / CSRF against the local server).
  const host = (req.headers.host || '').split(':')[0];
  if (!['127.0.0.1', 'localhost'].includes(host)) return send(res, 403, 'Forbidden');
  try {
    if (url.pathname === '/api/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(await health()));
    }
    if (url.pathname.startsWith('/api/')) {
      if (req.method !== 'POST') return send(res, 405, 'POST only');
      const origin = req.headers.origin;
      if (origin && !/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(origin)) return send(res, 403, 'Forbidden');
      return await handleOp(url.pathname.slice(5), req, res, url);
    }
    await serveStatic(res, decodeURIComponent(url.pathname));
  } catch (e) {
    if (res.headersSent) return res.destroy();
    if (e instanceof UserError) return send(res, 400, e.message);
    console.error(`[${url.pathname}]`, e.stderr || e.message);
    send(res, 500, 'Processing failed. ' + String(e.stderr || e.message).split('\n').filter(Boolean).slice(-2).join(' ').slice(0, 300));
  }
});

server.listen(PORT, '127.0.0.1', () => console.log(`pdfHero running at http://127.0.0.1:${PORT}`));
