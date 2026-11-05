// Word / Excel / PowerPoint / HTML -> printable HTML, shown in a locked-down frame and saved with the
// browser's own "Save as PDF". Everything is parsed here; nothing leaves the device.
import { h, VENDOR, UserError, bytesOf, NATIVE } from '../lib.js';

/** Desktop app: LibreOffice converts the file itself, layout intact. Returns null on the website (use the print preview). */
export async function officePdf(file) {
  const ext = file.name.split('.').pop().toLowerCase();
  if (!NATIVE?.has.soffice || /^html?$/.test(ext)) return null; // HTML stays in the sandboxed frame: LibreOffice would fetch its links
  try { return await NATIVE.office(await bytesOf(file), ext); } catch (e) { throw new UserError(e.message.replace(/^.*?remote method 'office': (Error: )?/, '')); }
}
/** Extra file types LibreOffice can read (old Office and OpenDocument formats). */
export const officeAccept = (types) => (NATIVE?.has.soffice ? `${types},${{ docx: '.doc,.odt,.rtf', xlsx: '.xls,.ods', pptx: '.ppt,.odp' }[types.split(',')[0].slice(1)]}` : types);

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const loadScript = (src, global) => (window[global] ? Promise.resolve() : new Promise((ok, fail) => {
  const s = h('script', { src }); s.onload = ok; s.onerror = () => fail(new Error(`${global} failed to load.`)); document.head.append(s);
}));
const BASE_CSS = 'body{font:11pt/1.4 Calibri,Carlito,Arial,sans-serif;color:#000;margin:0}img{max-width:100%}table{border-collapse:collapse}';

/** A sandboxed preview: no scripts, no forms, no navigation; inherits the app's no-network policy. */
export function printFrame(html, label) {
  const frame = h('iframe', { class: 'print-frame', title: label, sandbox: 'allow-same-origin allow-modals' });
  frame.srcdoc = html;
  // shrink to fit on screen only; printing still uses the real page size
  frame.addEventListener('load', () => {
    const d = frame.contentDocument; if (!d) return;
    const k = Math.min(1, (frame.clientWidth - 8) / Math.max(1, d.documentElement.scrollWidth));
    d.head.append(Object.assign(d.createElement('style'), { textContent: `@media screen{html{zoom:${k}}}` }));
  });
  return frame;
}

const doc = (css, body) => `<!doctype html><html><head><meta charset="utf-8"><style>${BASE_CSS}${css}</style></head><body>${body}</body></html>`;

// ---------- Word ----------
export async function docxHtml(file) {
  if (!/\.docx$/i.test(file.name)) throw new UserError('Only .docx Word files can be converted here (old .doc files: save them as .docx first).');
  await loadScript(`${VENDOR}mammoth.js`, 'mammoth');
  const { value } = await window.mammoth.convertToHtml({ arrayBuffer: await file.arrayBuffer() });
  return doc('@page{size:A4;margin:2.2cm}h1{font-size:20pt}h2{font-size:16pt}h3{font-size:13pt}td,th{border:1px solid #999;padding:3px 6px;vertical-align:top}p{margin:0 0 8pt}', value);
}

// ---------- Excel / CSV ----------
export async function sheetHtml(file) {
  let sheets;
  if (/\.csv$/i.test(file.name)) sheets = [{ name: file.name, rows: parseCsv(await file.text()) }];
  else if (/\.xlsx$/i.test(file.name)) sheets = await readXlsx(file);
  else throw new UserError('Only .xlsx and .csv files can be converted here (old .xls files: save them as .xlsx first).');
  const body = sheets.map((s, i) => `<section${i ? ' style="break-before:page"' : ''}><h2>${esc(s.name)}</h2><table>${s.rows.map((r) => `<tr>${r.map((c) => `<td${typeof c === 'number' ? ' class="n"' : ''}>${esc(c ?? '')}</td>`).join('')}</tr>`).join('')}</table></section>`).join('');
  return doc('@page{size:A4 landscape;margin:1.2cm}h2{font-size:12pt;margin:0 0 6pt}td{border:1px solid #bbb;padding:2px 5px;font-size:9pt;white-space:nowrap}td.n{text-align:right}', body);
}

function parseCsv(text) {
  const rows = []; let row = []; let cur = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; continue; }
    if (c === '"') q = true; else if (c === ',') { row.push(cur); cur = ''; } else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cur); rows.push(row); row = []; cur = ''; } else cur += c;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

async function readXlsx(file) {
  const z = await window.JSZip.loadAsync(await file.arrayBuffer());
  const xml = async (p) => { const f = z.file(p); return f ? new DOMParser().parseFromString(await f.async('text'), 'application/xml') : null; };
  const all = (d, tag) => (d ? [...d.getElementsByTagNameNS('*', tag)] : []);
  const shared = all(await xml('xl/sharedStrings.xml'), 'si').map((si) => all(si, 't').map((t) => t.textContent).join(''));
  const rels = Object.fromEntries(all(await xml('xl/_rels/workbook.xml.rels'), 'Relationship').map((r) => [r.getAttribute('Id'), r.getAttribute('Target')]));
  const out = [];
  for (const s of all(await xml('xl/workbook.xml'), 'sheet')) {
    const id = s.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id') || s.getAttribute('r:id');
    const target = rels[id]; if (!target) continue;
    const sheet = await xml(target.startsWith('/') ? target.slice(1) : `xl/${target}`);
    const rows = [];
    for (const r of all(sheet, 'row')) {
      const ri = +r.getAttribute('r') - 1; const row = [];
      for (const c of all(r, 'c')) {
        const ref = c.getAttribute('r') || ''; const col = [...ref.replace(/\d+/g, '')].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
        const t = c.getAttribute('t'); const v = all(c, 'v')[0]?.textContent;
        row[col] = t === 's' ? shared[+v] : t === 'inlineStr' ? all(c, 't').map((x) => x.textContent).join('') : t === 'b' ? (v === '1' ? 'TRUE' : 'FALSE') : t === 'str' || t === 'e' ? v : v != null ? Number(v) : '';
      }
      rows[ri] = row;
    }
    out.push({ name: s.getAttribute('name'), rows: Array.from(rows, (r) => r || []) });
  }
  if (!out.length) throw new UserError('No sheets found in this workbook.');
  return out;
}

// ---------- PowerPoint ----------
const EMU_PT = 12700;
export async function pptxHtml(file) {
  if (!/\.pptx$/i.test(file.name)) throw new UserError('Only .pptx PowerPoint files can be converted here (old .ppt files: save them as .pptx first).');
  const z = await window.JSZip.loadAsync(await file.arrayBuffer());
  const parse = async (p) => { const f = z.file(p); return f ? new DOMParser().parseFromString(await f.async('text'), 'application/xml') : null; };
  const all = (d, tag) => (d ? [...d.getElementsByTagNameNS('*', tag)] : []);
  const one = (d, tag) => all(d, tag)[0];
  const relsOf = async (part) => {
    const dir = part.slice(0, part.lastIndexOf('/')); const name = part.slice(part.lastIndexOf('/') + 1);
    const r = await parse(`${dir}/_rels/${name}.rels`);
    return Object.fromEntries(all(r, 'Relationship').map((x) => [x.getAttribute('Id'), resolve(dir, x.getAttribute('Target'))]));
  };
  const resolve = (dir, t) => { const parts = (t.startsWith('/') ? t.slice(1) : `${dir}/${t}`).split('/'); const out = []; for (const p of parts) p === '..' ? out.pop() : p !== '.' && out.push(p); return out.join('/'); };
  const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

  const pres = await parse('ppt/presentation.xml');
  const size = one(pres, 'sldSz');
  const W = +size.getAttribute('cx') / EMU_PT; const H = +size.getAttribute('cy') / EMU_PT;
  const presRels = await relsOf('ppt/presentation.xml');
  const slidePaths = all(pres, 'sldId').map((s) => presRels[s.getAttributeNS(R, 'id')]).filter(Boolean);
  if (!slidePaths.length) throw new UserError('No slides found in this presentation.');

  const mediaUrl = async (path) => {
    const f = z.file(path); if (!f) return null;
    const ext = path.split('.').pop().toLowerCase();
    const type = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', svg: 'image/svg+xml', bmp: 'image/bmp' }[ext];
    return type ? `data:${type};base64,${await f.async('base64')}` : null;
  };
  const box = (el) => {
    const xf = one(el, 'xfrm'); const off = xf && one(xf, 'off'); const ext = xf && one(xf, 'ext');
    return off && ext ? { x: +off.getAttribute('x') / EMU_PT, y: +off.getAttribute('y') / EMU_PT, w: +ext.getAttribute('cx') / EMU_PT, h: +ext.getAttribute('cy') / EMU_PT } : null;
  };
  const colour = (el) => { const c = el && one(el, 'srgbClr'); return c ? `#${c.getAttribute('val')}` : null; };

  const slides = [];
  for (const sp of slidePaths) {
    const slide = await parse(sp); const rels = await relsOf(sp);
    const layoutPath = Object.values(rels).find((p) => /slideLayouts\//.test(p));
    const layout = layoutPath ? await parse(layoutPath) : null;
    const masterPath = layoutPath ? Object.values(await relsOf(layoutPath)).find((p) => /slideMasters\//.test(p)) : null;
    const master = masterPath ? await parse(masterPath) : null;
    // placeholders without their own position inherit it from the layout, then the master (by index, then type)
    const fromLayout = (ph) => {
      if (!ph) return null;
      const type = (ph.getAttribute('type') || 'body').replace('ctrTitle', 'title').replace('subTitle', 'body'); const idx = ph.getAttribute('idx');
      for (const d of [layout, master]) {
        const cand = all(d, 'sp').find((s) => { const p = one(s, 'ph'); return p && box(s) && ((idx && p.getAttribute('idx') === idx) || (p.getAttribute('type') || 'body').replace('ctrTitle', 'title').replace('subTitle', 'body') === type); });
        if (cand) return box(cand);
      }
      return null;
    };
    let html = '';
    const bg = colour(one(one(slide, 'bg'), 'solidFill'));
    for (const el of [...(one(slide, 'spTree')?.children || [])]) {
      const kind = el.localName;
      if (kind === 'sp') {
        const ph = one(el, 'ph');
        const b = box(el) || fromLayout(ph); if (!b) continue;
        const isTitle = ph && /title/i.test(ph.getAttribute('type') || '');
        const fill = colour(one(one(el, 'spPr'), 'solidFill'));
        const paras = all(one(el, 'txBody'), 'p').map((p) => {
          const algn = one(p, 'pPr')?.getAttribute('algn');
          const runs = all(p, 'r').map((r) => {
            const pr = one(r, 'rPr'); const sz = pr?.getAttribute('sz');
            const st = [`font-size:${sz ? sz / 100 : isTitle ? 32 : 18}pt`];
            if (pr?.getAttribute('b') === '1') st.push('font-weight:bold');
            if (pr?.getAttribute('i') === '1') st.push('font-style:italic');
            const c = colour(one(pr, 'solidFill')); if (c) st.push(`color:${c}`);
            return `<span style="${st.join(';')}">${esc(one(r, 't')?.textContent || '')}</span>`;
          }).join('');
          const bullet = !isTitle && ph && runs && !one(one(p, 'pPr'), 'buNone') ? '• ' : '';
          return `<p style="margin:0 0 4pt;text-align:${{ ctr: 'center', r: 'right', just: 'justify' }[algn] || 'left'}">${bullet}${runs || '&nbsp;'}</p>`;
        }).join('');
        html += `<div style="position:absolute;left:${b.x}pt;top:${b.y}pt;width:${b.w}pt;height:${b.h}pt;${fill ? `background:${fill};` : ''}overflow:hidden;display:flex;flex-direction:column;justify-content:${isTitle ? 'center' : 'flex-start'}">${paras}</div>`;
      } else if (kind === 'pic') {
        const b = box(el); const id = one(el, 'blip')?.getAttributeNS(R, 'embed');
        const url = b && id && rels[id] ? await mediaUrl(rels[id]) : null;
        if (url) html += `<img alt="" src="${url}" style="position:absolute;left:${b.x}pt;top:${b.y}pt;width:${b.w}pt;height:${b.h}pt;object-fit:fill">`;
      }
    }
    slides.push(`<div class="slide"${bg ? ` style="background:${bg}"` : ''}>${html}</div>`);
  }
  return doc(`@page{size:${W}pt ${H}pt;margin:0}.slide{position:relative;width:${W}pt;height:${H}pt;overflow:hidden;break-after:page;background:#fff}body{background:#fff}`, slides.join(''));
}

// ---------- HTML ----------
export async function htmlFile(file) {
  const text = new TextDecoder().decode(await bytesOf(file));
  return text;
}
