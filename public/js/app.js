// App shell: home grid, hash router, and the generic tool page (S02).
import { h, sizeLabel, download, zip, health, UserError, thumbnail } from './lib.js';
import organize from './tools/organize.js';
import edit from './tools/edit.js';
import convert from './tools/convert.js';
import security from './tools/security.js';

export const CATEGORIES = [
  ['organize', 'Organize'], ['optimize', 'Optimize'], ['to', 'Convert to PDF'], ['from', 'Convert from PDF'],
  ['edit', 'Edit'], ['security', 'Security'], ['intel', 'Text & data'],
];
export const TOOLS = [...organize, ...edit, ...convert, ...security];
const byId = Object.fromEntries(TOOLS.map((t) => [t.id, t]));

const INSTALL = {
  gs: 'brew install ghostscript', qpdf: 'brew install qpdf', ocrmypdf: 'brew install ocrmypdf tesseract-lang',
  soffice: 'brew install --cask libreoffice', chrome: 'install Google Chrome',
  'python:pdf2docx': 'npm run setup', 'python:pdfplumber': 'npm run setup',
  'python:openpyxl': 'npm run setup', 'python:pptx': 'npm run setup',
};
const NEEDS = { compress: ['gs'], repair: ['qpdf'], ocr: ['ocrmypdf'], pdfa: ['ocrmypdf'], protect: ['qpdf'], unlock: ['qpdf'],
  office2pdf: ['soffice'], pdf2word: ['python:pdf2docx'], pdf2excel: ['python:pdfplumber', 'python:openpyxl'], pdf2ppt: ['gs', 'python:pptx'], html2pdf: ['chrome'] };

const app = document.getElementById('app');
addEventListener('hashchange', route);
route();

function route() {
  const id = location.hash.replace(/^#\/?/, '');
  window.scrollTo(0, 0);
  if (byId[id]) toolPage(byId[id]);
  else home();
  document.querySelector('#app h1')?.focus();
}

// ---------------- S01 home ----------------
function home() {
  document.title = 'pdfHero — private PDF tools';
  let cat = 'all'; let q = '';
  const grid = h('div', { class: 'grid', id: 'tool-grid' });
  const tabs = h('div', { class: 'tabs', role: 'group', 'aria-label': 'Category' },
    [['all', 'All'], ...CATEGORIES].map(([id, label]) => h('button', {
      class: 'tab', type: 'button', 'aria-pressed': String(id === cat), onclick: (e) => {
        cat = id; tabs.querySelectorAll('.tab').forEach((b) => b.setAttribute('aria-pressed', String(b === e.currentTarget))); paint();
      },
    }, label)));
  const search = h('input', { type: 'search', class: 'input search', placeholder: 'Find a tool…', 'aria-label': 'Find a tool', oninput: (e) => { q = e.target.value.toLowerCase(); paint(); } });

  function paint() {
    const list = TOOLS.filter((t) => (cat === 'all' || t.cat === cat) && (!q || `${t.name} ${t.desc}`.toLowerCase().includes(q)));
    grid.replaceChildren(...(list.length ? list.map(card) : [h('p', { class: 'empty' }, `No tool matches “${q}”.`)]));
  }
  const card = (t) => h('a', { class: 'card', href: `#/${t.id}` },
    h('span', { class: `card-icon cat-${t.cat}`, 'aria-hidden': 'true' }, t.icon),
    h('span', { class: 'card-title' }, t.name),
    h('span', { class: 'card-desc' }, t.desc),
    t.server ? h('span', { class: 'badge', title: 'Runs on this computer through the local helper' }, 'local helper') : null);

  app.replaceChildren(
    h('section', { class: 'hero' },
      h('h1', { tabindex: -1 }, 'Every PDF tool, on your own machine'),
      h('p', { class: 'lead' }, 'Nothing is uploaded anywhere. Files stay in this browser tab or go to the helper running on this computer, and are gone when you close it.')),
    h('div', { class: 'toolbar' }, tabs, search),
    grid,
  );
  paint();
}

// ---------------- S02 tool page ----------------
async function toolPage(tool) {
  document.title = `${tool.name} — pdfHero`;
  const ctx = { tool, files: [], custom: null };
  const banner = h('div', { role: 'status' });
  const work = h('div', { class: 'work' });
  const drop = dropZone(tool, addFiles);

  app.replaceChildren(
    h('nav', { class: 'crumbs', 'aria-label': 'Breadcrumb' }, h('a', { href: '#/' }, 'All tools'), ' / ', tool.name),
    h('header', { class: 'tool-head' },
      h('span', { class: `card-icon lg cat-${tool.cat}`, 'aria-hidden': 'true' }, tool.icon),
      h('div', {}, h('h1', { tabindex: -1 }, tool.name), h('p', { class: 'lead' }, tool.desc))),
    banner, drop, work,
  );

  if (tool.server) {
    const hl = await health();
    if (!hl.ops?.[tool.server]) {
      const missing = (NEEDS[tool.server] || []).filter((n) => !hl.tools?.[n]);
      banner.replaceChildren(h('div', { class: 'alert warn' },
        h('strong', {}, 'This tool needs a converter that is not installed. '),
        missing.length ? h('span', {}, 'Run: ', ...missing.map((m) => h('code', {}, INSTALL[m] || m)), ' then restart pdfHero.') : 'Is the pdfHero server running?'));
    }
    ctx.health = hl;
  }

  if (tool.minFiles === 0) paintWork();

  async function addFiles(list) {
    const ok = [...list].filter((f) => accepts(tool, f));
    const bad = [...list].length - ok.length;
    banner.querySelector('.alert.err')?.remove();
    if (bad) banner.append(h('div', { class: 'alert err' }, `${bad} file${bad > 1 ? 's' : ''} skipped: this tool takes ${tool.accept || '.pdf'} files.`));
    if (!ok.length) return;
    ctx.files = tool.multiple ? [...ctx.files, ...ok] : [ok[0]];
    ctx.custom = null;
    await paintWork();
  }

  async function paintWork() {
    drop.hidden = !!ctx.files.length && !tool.multiple;
    drop.classList.toggle('compact', !!ctx.files.length);
    if (!ctx.files.length && tool.minFiles !== 0) return work.replaceChildren();
    const opts = {};
    const optsEl = h('div', { class: 'options' }, ...renderOptions(tool.options?.(ctx) || [], opts));
    const runBtn = h('button', { class: 'btn primary lg', type: 'button' }, tool.action || tool.name);
    const out = h('div', { class: 'result', 'aria-live': 'polite' });
    const main = h('div', { class: 'files' });
    if (tool.mount) {
      main.append(h('p', { class: 'muted' }, 'Loading pages…'));
      try { ctx.custom = await tool.mount(ctx); main.replaceChildren(ctx.custom.el); } catch (e) { main.replaceChildren(errBox(e)); }
    } else if (ctx.files.length) {
      main.append(fileList(ctx, tool, paintWork));
    }
    runBtn.addEventListener('click', async () => {
      runBtn.disabled = true; out.replaceChildren(h('div', { class: 'progress' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), h('span', {}, 'Working…')));
      const progress = (txt) => { out.querySelector('.progress span:last-child').textContent = txt; };
      try {
        const results = await tool.run(ctx.files, opts, { ...ctx, progress });
        out.replaceChildren(resultBox(results, tool));
        out.querySelector('button')?.focus();
      } catch (e) {
        if (!(e instanceof UserError)) console.error(e);
        out.replaceChildren(errBox(e));
      } finally { runBtn.disabled = false; }
    });
    work.replaceChildren(h('div', { class: 'work-grid' }, main,
      h('aside', { class: 'panel' }, h('h2', {}, 'Options'), optsEl, runBtn, out)));
  }
}

function accepts(tool, f) {
  const exts = (tool.accept || '.pdf').split(',').map((s) => s.trim().toLowerCase());
  return exts.some((e) => e === '*' || (e.endsWith('/*') ? f.type.startsWith(e.slice(0, -1)) : f.name.toLowerCase().endsWith(e)));
}

function dropZone(tool, onFiles) {
  const input = h('input', { type: 'file', accept: tool.accept || '.pdf', multiple: tool.multiple, class: 'sr-only', id: 'file-in', onchange: (e) => { onFiles(e.target.files); e.target.value = ''; } });
  const z = h('div', { class: 'drop' },
    input,
    h('label', { for: 'file-in', class: 'btn primary lg' }, tool.multiple ? 'Choose files' : 'Choose a file'),
    h('p', { class: 'muted' }, 'or drop them here'));
  for (const ev of ['dragenter', 'dragover']) z.addEventListener(ev, (e) => { e.preventDefault(); z.classList.add('over'); });
  for (const ev of ['dragleave', 'drop']) z.addEventListener(ev, () => z.classList.remove('over'));
  z.addEventListener('drop', (e) => { e.preventDefault(); onFiles(e.dataTransfer.files); });
  if (tool.minFiles === 0) z.querySelector('p').textContent = 'optional — or use the options on the right';
  return z;
}

function fileList(ctx, tool, repaint) {
  const ul = h('ul', { class: 'file-list', 'aria-label': 'Files' });
  ctx.files.forEach((f, i) => {
    const thumb = h('div', { class: 'thumb' });
    if (f.name.toLowerCase().endsWith('.pdf')) thumbnail(f, 1, 120).then((c) => thumb.append(c)).catch(() => thumb.append(h('span', { class: 'muted' }, 'PDF')));
    else if (f.type.startsWith('image/')) thumb.append(h('img', { src: URL.createObjectURL(f), alt: '' }));
    else thumb.append(h('span', { class: 'ext' }, f.name.split('.').pop().toUpperCase()));
    const move = (d) => { const j = i + d; [ctx.files[i], ctx.files[j]] = [ctx.files[j], ctx.files[i]]; repaint(); };
    ul.append(h('li', { class: 'file' }, thumb,
      h('div', { class: 'file-meta' }, h('span', { class: 'file-name', title: f.name }, f.name), h('span', { class: 'muted' }, sizeLabel(f.size))),
      h('div', { class: 'file-actions' },
        tool.multiple && i > 0 ? h('button', { class: 'btn ghost sm', type: 'button', 'aria-label': `Move ${f.name} earlier`, onclick: () => move(-1) }, '↑') : null,
        tool.multiple && i < ctx.files.length - 1 ? h('button', { class: 'btn ghost sm', type: 'button', 'aria-label': `Move ${f.name} later`, onclick: () => move(1) }, '↓') : null,
        h('button', { class: 'btn ghost sm', type: 'button', 'aria-label': `Remove ${f.name}`, onclick: () => { ctx.files.splice(i, 1); repaint(); } }, '×'))));
  });
  return ul;
}

/** Options schema -> form controls. Values land in `opts` live. */
function renderOptions(schema, opts) {
  const rows = [];
  const refresh = () => rows.forEach(([o, el]) => { el.hidden = o.show ? !o.show(opts) : false; });
  for (const o of schema) {
    opts[o.key] = o.default ?? (o.type === 'checkbox' ? false : o.type === 'select' ? o.choices[0][0] : '');
    const id = `opt-${o.key}`;
    const set = (v) => { opts[o.key] = v; refresh(); };
    let input;
    if (o.type === 'select') input = h('select', { id, class: 'input', oninput: (e) => set(e.target.value) }, o.choices.map(([v, l]) => h('option', { value: v, selected: v === opts[o.key] }, l)));
    else if (o.type === 'seg') {
      input = h('div', { class: 'seg', role: 'radiogroup', 'aria-labelledby': `${id}-l` }, o.choices.map(([v, l]) => h('button', {
        class: 'seg-btn', type: 'button', role: 'radio', 'aria-checked': String(v === opts[o.key]),
        onclick: (e) => { input.querySelectorAll('button').forEach((b) => b.setAttribute('aria-checked', String(b === e.currentTarget))); set(v); },
      }, l)));
    } else if (o.type === 'checkbox') input = h('input', { id, type: 'checkbox', checked: !!opts[o.key], oninput: (e) => set(e.target.checked) });
    else if (o.type === 'file') input = h('input', { id, type: 'file', accept: o.accept, class: 'input', oninput: (e) => set(e.target.files[0] || null) });
    else if (o.type === 'textarea') input = h('textarea', { id, class: 'input', rows: 3, placeholder: o.placeholder, oninput: (e) => set(e.target.value) }, opts[o.key]);
    else input = h('input', { id, class: 'input', type: o.type || 'text', value: opts[o.key], placeholder: o.placeholder, min: o.min, max: o.max, step: o.step, autocomplete: o.type === 'password' ? 'new-password' : 'off', oninput: (e) => set(o.type === 'number' || o.type === 'range' ? +e.target.value : e.target.value) });
    const row = o.type === 'checkbox'
      ? h('div', { class: 'opt check' }, input, h('label', { for: id }, o.label))
      : h('div', { class: 'opt' }, h('label', { for: id, id: `${id}-l` }, o.label), input, o.help ? h('small', { class: 'muted' }, o.help) : null);
    rows.push([o, row]);
  }
  refresh();
  return rows.map((r) => r[1]);
}

function resultBox(results, tool) {
  if (!results?.length) return h('div', { class: 'alert warn' }, 'Nothing was produced.');
  const total = results.reduce((n, r) => n + r.blob.size, 0);
  const box = h('div', { class: 'done' }, h('p', { class: 'done-title' }, '✓ Done'));
  if (tool.report) box.append(h('p', { class: 'muted' }, tool.report(results)));
  if (results[0].view) box.append(results[0].view);
  if (results.length === 1) {
    box.append(h('button', { class: 'btn primary', type: 'button', onclick: () => download(results[0].blob, results[0].name) }, `Download ${results[0].name}`), h('small', { class: 'muted' }, sizeLabel(results[0].blob.size)));
  } else {
    box.append(h('button', { class: 'btn primary', type: 'button', onclick: async () => { const z = await zip(results, `${tool.id}-files.zip`); download(z.blob, z.name); } }, `Download all (${results.length} files, ZIP)`),
      h('small', { class: 'muted' }, sizeLabel(total)),
      h('ul', { class: 'res-list' }, results.map((r) => h('li', {}, h('button', { class: 'link', type: 'button', onclick: () => download(r.blob, r.name) }, r.name), ' ', h('span', { class: 'muted' }, sizeLabel(r.blob.size))))));
  }
  return box;
}

function errBox(e) {
  return h('div', { class: 'alert err', role: 'alert' }, e instanceof UserError ? e.message : `Something went wrong: ${e.message}`);
}
