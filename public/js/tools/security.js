import { h, loadPdfLib, loadPdfJs, renderPage, canvasBlob, embedImage, pdfBlob, baseName, UserError } from '../lib.js';
import { serverTool, pageLines } from './convert.js';
import { pageEditor, applyItems } from '../editor.js';

const enc = encodeURIComponent;

export default [
  serverTool({
    id: 'protect', cat: 'security', icon: '🔒', name: 'Protect PDF', action: 'Encrypt', op: 'protect', outSuffix: '_protected',
    desc: 'Lock a PDF with a password (AES-256). Nobody can open it without the password.',
    options: () => [
      { key: 'pw', label: 'Password', type: 'password' },
      { key: 'pw2', label: 'Repeat password', type: 'password' },
    ],
    headers(o) {
      if (!o.pw) throw new UserError('Type a password.');
      if (o.pw !== o.pw2) throw new UserError('The two passwords don’t match.');
      return { 'X-Password': enc(o.pw) };
    },
  }),
  serverTool({
    id: 'unlock', cat: 'security', icon: '🔓', name: 'Unlock PDF', action: 'Unlock', op: 'unlock', outSuffix: '_unlocked',
    desc: 'Remove the password and restrictions from a PDF you have the right to open.',
    options: () => [{ key: 'pw', label: 'Password (if it needs one to open)', type: 'password', help: 'Files that only restrict printing or copying unlock without one.' }],
    headers: (o) => (o.pw ? { 'X-Password': enc(o.pw) } : {}),
  }),
  {
    id: 'sign', cat: 'security', icon: '✍', name: 'Sign PDF', action: 'Save signed PDF',
    desc: 'Draw, type or upload your signature and place it on the page, along with dates or initials.',
    async mount(ctx) {
      const pad = signaturePad();
      const ed = pageEditor(ctx.files[0], { tools: [
        { id: 'sig', label: 'Place signature', kind: 'image', width: 160, pick: async () => (await pad.get()) || (alert('Create your signature first (above).'), null) },
        { id: 'date', label: 'Date', kind: 'text', styled: true, text: () => new Date().toLocaleDateString() },
        { id: 'text', label: 'Text', kind: 'text', styled: true },
      ] });
      await ed.ready;
      return { el: h('div', { class: 'stack' }, pad.el, h('p', { class: 'muted' }, 'Then choose “Place signature” and click where it goes. Drag the corner to resize.'), ed.el), ed };
    },
    async run([f], o, ctx) {
      const items = ctx.custom.ed.state.items;
      if (!items.some((i) => i.type === 'image')) throw new UserError('Place your signature on the page first.');
      const doc = await loadPdfLib(f);
      await applyItems(doc, items);
      return [{ name: `${baseName(f.name)}_signed.pdf`, blob: await pdfBlob(doc) }];
    },
  },
  {
    id: 'redact', cat: 'security', icon: '▬', name: 'Redact PDF', action: 'Redact permanently',
    desc: 'Black out text and areas for good: redacted pages are flattened, so the hidden content is really gone.',
    options: () => [
      { key: 'dpi', label: 'Quality of redacted pages', type: 'seg', choices: [['150', 'Normal'], ['220', 'High']], default: '150' },
      { key: 'meta', label: 'Also remove document properties (title, author…)', type: 'checkbox', default: true },
    ],
    async mount(ctx) {
      const ed = pageEditor(ctx.files[0], { tools: [{ id: 'redact', label: 'Draw box', kind: 'box', type: 'redact' }] });
      const term = h('input', { class: 'input', type: 'search', placeholder: 'Word or phrase', 'aria-label': 'Text to find and redact' });
      const msg = h('span', { class: 'muted', 'aria-live': 'polite' });
      const find = h('button', { class: 'btn secondary sm', type: 'button', onclick: async () => {
        const n = await markMatches(ctx.files[0], term.value, ed); msg.textContent = n ? `${n} match(es) marked on all pages.` : 'No matches.';
      } }, 'Mark all matches');
      await ed.ready;
      return { el: h('div', { class: 'stack' }, h('div', { class: 'row gap-sm wrap' }, term, find, msg), ed.el), ed };
    },
    async run([f], o, ctx) {
      const items = ctx.custom.ed.state.items.filter((i) => i.type === 'redact');
      if (!items.length) throw new UserError('Mark at least one area to redact.');
      const doc = await loadPdfLib(f);
      const js = await loadPdfJs(f);
      const pagesHit = [...new Set(items.map((i) => i.page))].sort((a, b) => a - b);
      for (const n of pagesHit) {
        ctx.progress(`Flattening page ${n}…`);
        const page = await js.getPage(n);
        const k = +o.dpi / 72;
        const c = await renderPage(page, k);
        const g = c.getContext('2d'); g.fillStyle = '#000';
        for (const it of items.filter((i) => i.page === n)) g.fillRect(it.x * k, it.y * k, it.w * k, it.h * k);
        const img = await embedImage(doc, await canvasBlob(c, 'image/jpeg', 0.9));
        const vp = page.getViewport({ scale: 1 });
        doc.removePage(n - 1);
        doc.insertPage(n - 1, [vp.width, vp.height]).drawImage(img, { x: 0, y: 0, width: vp.width, height: vp.height });
        c.width = 0;
      }
      if (o.meta) { doc.setTitle(''); doc.setAuthor(''); doc.setSubject(''); doc.setKeywords([]); doc.setCreator(''); doc.setProducer(''); }
      return [{ name: `${baseName(f.name)}_redacted.pdf`, blob: await pdfBlob(doc) }];
    },
  },
  {
    id: 'compare', cat: 'security', icon: '⇄', name: 'Compare PDF', action: 'Compare', multiple: true,
    desc: 'Spot the differences between two versions of a document, by text and by look.',
    options: () => [{ key: 'mode', label: 'Compare', type: 'seg', choices: [['text', 'Text'], ['visual', 'Visual overlay']], default: 'text' }],
    async run(files, o, ctx) {
      if (files.length !== 2) throw new UserError('Add exactly two PDFs: the old version first, then the new one.');
      const [a, b] = await Promise.all(files.map(loadPdfJs));
      const n = Math.max(a.numPages, b.numPages);
      if (o.mode === 'visual') {
        const view = h('div', { class: 'diff-visual' }, h('p', { class: 'muted' }, 'Dark = same. Bright = different.'));
        const out = [];
        for (let i = 1; i <= Math.min(n, 50); i++) {
          ctx.progress(`Page ${i} of ${n}…`);
          const ca = i <= a.numPages ? await renderPage(await a.getPage(i), 1) : null;
          const cb = i <= b.numPages ? await renderPage(await b.getPage(i), 1) : null;
          const c = h('canvas', { width: Math.max(ca?.width || 0, cb?.width || 0), height: Math.max(ca?.height || 0, cb?.height || 0), 'aria-label': `Difference on page ${i}` });
          const g = c.getContext('2d');
          g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
          if (ca) g.drawImage(ca, 0, 0);
          g.globalCompositeOperation = 'difference';
          if (cb) g.drawImage(cb, 0, 0); else { g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); }
          view.append(h('figure', {}, c, h('figcaption', {}, `Page ${i}`)));
          out.push({ name: `difference_page${i}.png`, blob: await canvasBlob(c) });
        }
        out[0].view = view;
        return out;
      }
      const rows = []; let changes = 0;
      for (let i = 1; i <= n; i++) {
        ctx.progress(`Reading page ${i} of ${n}…`);
        const la = i <= a.numPages ? (await pageLines(await a.getPage(i))).map((l) => l.text) : [];
        const lb = i <= b.numPages ? (await pageLines(await b.getPage(i))).map((l) => l.text) : [];
        const d = diffLines(la, lb);
        const changed = d.filter((x) => x[0] !== '=').length;
        changes += changed;
        rows.push({ page: i, d, changed });
      }
      const view = h('div', { class: 'diff' }, h('p', {}, changes ? `${changes} changed line(s).` : 'No text differences found.'),
        rows.filter((r) => r.changed).map((r) => h('section', {}, h('h3', {}, `Page ${r.page}`),
          h('ul', { class: 'diff-lines' }, r.d.filter((x) => x[0] !== '=').map(([op, t]) => h('li', { class: op === '+' ? 'add' : 'del' }, h('span', { class: 'sr-only' }, op === '+' ? 'Added: ' : 'Removed: '), `${op} ${t}`))))));
      const report = `<!doctype html><meta charset="utf-8"><title>Comparison</title><style>body{font:14px system-ui;max-width:900px;margin:2em auto}.add{background:#e6f6ea}.del{background:#fde8e8;text-decoration:line-through}li{list-style:none;padding:2px 6px}</style><h1>${esc(files[0].name)} → ${esc(files[1].name)}</h1>${view.innerHTML}`;
      return [{ name: 'comparison.html', blob: new Blob([report], { type: 'text/html' }), view }];
    },
  },
];

const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** Line diff via LCS. Returns [['=',line] | ['-',line] | ['+',line]]. */
export function diffLines(a, b) {
  const m = a.length; const n = b.length;
  const L = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1));
  for (let i = m - 1; i >= 0; i--) for (let j = n - 1; j >= 0; j--) L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out = []; let i = 0; let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) { out.push(['=', a[i]]); i++; j++; } else if (L[i + 1][j] >= L[i][j + 1]) out.push(['-', a[i++]]); else out.push(['+', b[j++]]);
  }
  while (i < m) out.push(['-', a[i++]]);
  while (j < n) out.push(['+', b[j++]]);
  return out;
}

async function markMatches(file, term, ed) {
  term = term.trim().toLowerCase();
  if (!term) return 0;
  const doc = await loadPdfJs(file);
  let count = 0;
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const vp = page.getViewport({ scale: 1 });
    for (const it of (await page.getTextContent()).items) {
      const s = (it.str || '').toLowerCase();
      if (!s) continue;
      const size = Math.hypot(it.transform[2], it.transform[3]);
      for (let k = s.indexOf(term); k >= 0; k = s.indexOf(term, k + term.length)) {
        const [x0, y0] = vp.convertToViewportPoint(it.transform[4] + (it.width * k) / s.length, it.transform[5]);
        const w = (it.width * term.length) / s.length;
        ed.state.items.push({ id: Math.random(), page: p, type: 'redact', x: x0 - 1, y: y0 - size * 0.95, w: w + 2, h: size * 1.2 });
        count++;
      }
    }
  }
  ed.redraw();
  return count;
}

function signaturePad() {
  let mode = 'draw';
  const color = h('input', { type: 'color', value: '#1a2b8c', 'aria-label': 'Ink colour' });
  const canvas = h('canvas', { width: 600, height: 180, class: 'sig-canvas', 'aria-label': 'Draw your signature here' });
  const g = canvas.getContext('2d');
  let drawn = false;
  canvas.addEventListener('pointerdown', (e) => {
    if (mode !== 'draw') return;
    const r = canvas.getBoundingClientRect(); const k = canvas.width / r.width;
    g.strokeStyle = color.value; g.lineWidth = 3; g.lineCap = g.lineJoin = 'round';
    g.beginPath(); g.moveTo((e.clientX - r.left) * k, (e.clientY - r.top) * k);
    const mv = (ev) => { g.lineTo((ev.clientX - r.left) * k, (ev.clientY - r.top) * k); g.stroke(); drawn = true; };
    const up = () => { canvas.removeEventListener('pointermove', mv); removeEventListener('pointerup', up); };
    canvas.setPointerCapture(e.pointerId);
    canvas.addEventListener('pointermove', mv); addEventListener('pointerup', up);
  });
  const typed = h('input', { class: 'input', placeholder: 'Type your name', 'aria-label': 'Your name' });
  const font = h('select', { class: 'input', 'aria-label': 'Signature style' },
    ['Snell Roundhand', 'Brush Script MT', 'Apple Chancery', 'Zapfino', 'Bradley Hand', 'cursive'].map((f) => h('option', { value: f }, f)));
  const upload = h('input', { type: 'file', accept: 'image/*', class: 'input', 'aria-label': 'Signature image' });
  const panes = {
    draw: h('div', {}, canvas, h('button', { class: 'btn ghost sm', type: 'button', onclick: () => { g.clearRect(0, 0, canvas.width, canvas.height); drawn = false; } }, 'Clear')),
    type: h('div', { class: 'row gap-sm wrap' }, typed, font),
    upload: h('div', {}, upload, h('small', { class: 'muted' }, 'A PNG with a transparent background looks best.')),
  };
  const tabs = h('div', { class: 'seg', role: 'tablist' }, Object.keys(panes).map((k) => h('button', {
    class: 'seg-btn', type: 'button', role: 'tab', 'aria-selected': String(k === mode),
    onclick: (e) => { mode = k; tabs.querySelectorAll('button').forEach((b) => b.setAttribute('aria-selected', String(b === e.currentTarget))); Object.entries(panes).forEach(([n, p]) => { p.hidden = n !== k; }); },
  }, k[0].toUpperCase() + k.slice(1))));
  Object.entries(panes).forEach(([n, p]) => { p.hidden = n !== mode; });

  async function get() {
    if (mode === 'upload') return upload.files[0] || null;
    if (mode === 'type') {
      if (!typed.value.trim()) return null;
      const c = h('canvas', { width: 900, height: 220 }); const x = c.getContext('2d');
      x.font = `110px "${font.value}", cursive`; x.fillStyle = color.value; x.textBaseline = 'middle';
      c.width = Math.ceil(x.measureText(typed.value).width) + 40;
      x.font = `110px "${font.value}", cursive`; x.fillStyle = color.value; x.textBaseline = 'middle';
      x.fillText(typed.value, 20, 115);
      return trim(c);
    }
    return drawn ? trim(canvas) : null;
  }
  return { el: h('section', { class: 'sig-pad panel-inline', 'aria-label': 'Your signature' }, h('div', { class: 'row gap-sm wrap' }, h('strong', {}, 'Your signature'), tabs, color), ...Object.values(panes)), get };
}

/** Crop transparent edges off a canvas and return a PNG blob. */
async function trim(c) {
  const { data, width, height } = c.getContext('2d').getImageData(0, 0, c.width, c.height);
  let x0 = width; let y0 = height; let x1 = 0; let y1 = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (data[(y * width + x) * 4 + 3] > 8) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  if (x1 < x0) return null;
  const out = h('canvas', { width: x1 - x0 + 8, height: y1 - y0 + 8 });
  out.getContext('2d').drawImage(c, x0 - 4, y0 - 4, out.width, out.height, 0, 0, out.width, out.height);
  return canvasBlob(out);
}
