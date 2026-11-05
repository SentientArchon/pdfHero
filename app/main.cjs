// pdfHero desktop app: the same UI as the website, loaded from disk, with Ghostscript, qpdf and LibreOffice
// run natively. Nothing is downloaded and the window may not contact any other host.
const { app, BrowserWindow, protocol, ipcMain, session } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const { existsSync, realpathSync } = require('node:fs');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..', 'public');
const find = (...c) => c.find((p) => existsSync(p)) || null;
const BIN = {
  gs: find('/opt/homebrew/bin/gs', '/usr/local/bin/gs'),
  qpdf: find('/opt/homebrew/bin/qpdf', '/usr/local/bin/qpdf'),
  soffice: find('/Applications/LibreOffice.app/Contents/MacOS/soffice'),
};
// Homebrew's Ghostscript has no %rom% filesystem; PDF/A reads its sRGB profile from disk instead.
const ICC = BIN.gs && find(path.join(realpathSync(BIN.gs), '../../share/ghostscript/iccprofiles/srgb.icc'));

protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

const exec = (bin, args, opts) => new Promise((resolve) => {
  execFile(bin, args, { maxBuffer: 1 << 26, timeout: 30 * 60e3, ...opts }, (err, stdout, stderr) => {
    const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
    resolve({ code, log: `${stdout}\n${stderr}`.split('\n').filter(Boolean).slice(-40) });
  });
});
async function inTemp(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pdfhero-'));
  try { return await fn(dir); } finally { await fs.rm(dir, { recursive: true, force: true }); }
}
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm', '.json': 'application/json', '.png': 'image/png', '.ttf': 'font/ttf' };
const NAME = /^\/[\w.-]+$/;
// The page only ever sends these shapes; anything else (a %pipe%, -c code, @argfile, a real path) is refused,
// so even a compromised page can't make the engines run commands or touch files outside the temp folder.
function argOk(engine, a, names) {
  if (names.includes(a)) return true;
  if (engine === 'gs') return a === '-dSAFER' || /^-d[A-Za-z]+(=[\w./]+)?$/.test(a) && !/SAFER/i.test(a) || /^-s(DEVICE|ColorConversionStrategy|ProcessColorModel)=\w+$/.test(a) || names.some((n) => a === `-sOutputFile=${n}`);
  return false;
}
// qpdf: only the three calls the tools make, input and output always last. Passwords sit only where qpdf reads passwords.
function qpdfOk(args) {
  const pre = args.slice(0, -2); const pw = (p) => !/^[-@]/.test(p);
  return args.slice(-2).join('\n') === '/in.pdf\n/out.pdf' && (!pre.length || (pre.length === 1 && pre[0] === '--decrypt')
    || (pre.length === 2 && /^--password=[^@]/s.test(pre[0]) && pre[1] === '--decrypt')
    || (pre.length === 5 && pre[0] === '--encrypt' && pw(pre[1]) && pw(pre[2]) && pre[3] === '256' && pre[4] === '--'));
}

// Same contract as the WASM worker: virtual files like "/in.pdf" are mapped into a private temp folder.
ipcMain.handle('run', (e, engine, args, files, outputs) => {
  if (!['gs', 'qpdf'].includes(engine) || !BIN[engine]) throw new Error(`${engine} is not installed.`);
  const names = [...Object.keys(files), ...outputs];
  if (!names.every((n) => NAME.test(n)) || !args.every((a) => typeof a === 'string')) throw new Error('Bad engine call.');
  if (engine === 'gs' ? !args.every((a) => argOk(engine, a, names)) : !qpdfOk(args)) throw new Error('Bad engine call.');
  if (engine === 'gs') args = ['-dSAFER', ...args];
  return inTemp(async (dir) => {
    const real = (n) => path.join(dir, n.slice(1));
    for (const [n, bytes] of Object.entries(files)) await fs.writeFile(real(n), bytes);
    const mapped = args.map((a, i) => { if (engine === 'qpdf' && i < args.length - 2) return a; // passwords are never paths
       const n = names.find((v) => a === v || a === `-sOutputFile=${v}`); return n ? a.slice(0, -n.length) + real(n) : a; });
    const r = await exec(BIN[engine], mapped, { cwd: dir });
    const out = {};
    for (const n of outputs) { try { out[n] = await fs.readFile(real(n)); } catch { /* not produced */ } }
    return { ...r, out };
  });
});

// Office -> PDF with LibreOffice. A profile of its own lets it run while the user has LibreOffice open.
ipcMain.handle('office', (e, bytes, ext) => {
  if (!BIN.soffice) throw new Error('LibreOffice is not installed.');
  if (!/^(docx?|xlsx?|pptx?|csv|odt|ods|odp|rtf)$/.test(ext)) throw new Error('Unsupported file type.');
  return inTemp(async (dir) => {
    const input = path.join(dir, `in.${ext}`);
    await fs.writeFile(input, bytes);
    const profile = pathToFileURL(path.join(app.getPath('userData'), 'libreoffice')).href;
    // sandboxed with no outbound network: a document's linked images or OLE links can't call out
    const r = await exec('/usr/bin/sandbox-exec', ['-p', '(version 1)(allow default)(deny network-outbound (remote ip))', BIN.soffice, '--headless', '--norestore', `-env:UserInstallation=${profile}`, '--convert-to', 'pdf', '--outdir', dir, input], { timeout: 10 * 60e3 });
    try { return await fs.readFile(path.join(dir, 'in.pdf')); } catch { throw new Error(`LibreOffice couldn’t convert this file. ${r.log.slice(-2).join(' ')}`); }
  });
});
ipcMain.on('has', (e) => { e.returnValue = { gs: !!BIN.gs, qpdf: !!BIN.qpdf, soffice: !!BIN.soffice, icc: ICC }; });

app.whenReady().then(() => {
  protocol.handle('app', (req) => {
    const file = path.join(ROOT, decodeURIComponent(new URL(req.url).pathname));
    if (!file.startsWith(ROOT + path.sep)) return new Response('Forbidden', { status: 403 });
    return fs.readFile(file).then((b) => new Response(b, { headers: { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' } }),
      () => new Response('Not found', { status: 404 }));
  });
  // files never leave the machine: every request that isn't the app itself is cancelled
  session.defaultSession.webRequest.onBeforeRequest((d, cb) => cb({ cancel: !/^(app|blob|data|devtools|chrome-extension):/.test(d.url) }));
  if (process.env.PDFHERO_DOWNLOADS) session.defaultSession.on('will-download', (e, item) => item.setSavePath(path.join(process.env.PDFHERO_DOWNLOADS, item.getFilename())));

  const win = new BrowserWindow({
    width: 1280, height: 900, title: 'pdfHero',
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, backgroundThrottling: false }, // jobs keep full speed while the window is hidden
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('app://')) e.preventDefault(); });
  win.loadURL('app://pdfhero/index.html');
});
app.on('window-all-closed', () => app.quit());
