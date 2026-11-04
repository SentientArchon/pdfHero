// Page editor: shows one page, lets the user place/move/resize items on it.
// Item coordinates are in PDF points, origin top-left of the page as displayed (scale 1 viewport).
import { h, loadPdfJs, renderPage, embedImage, hexToRgb, safeText, StandardFonts, rgb } from './lib.js';

let nextId = 1;

export function pageEditor(file, { tools, defaultTool, onChange = () => {}, toolbarExtra } = {}) {
  const state = { page: 1, pages: 1, scale: 1, tool: defaultTool || tools[0].id, items: [], selected: null, pendingImage: null };
  const style = { color: '#111111', size: 16, font: 'Helvetica', fill: '#000000', opacity: 1, stroke: 2 };

  const pageLabel = h('span', { class: 'muted', 'aria-live': 'polite' });
  const prev = h('button', { class: 'btn ghost sm', type: 'button', 'aria-label': 'Previous page', onclick: () => go(state.page - 1) }, '‹');
  const next = h('button', { class: 'btn ghost sm', type: 'button', 'aria-label': 'Next page', onclick: () => go(state.page + 1) }, '›');
  const toolButtons = tools.map((t) => h('button', {
    class: 'seg-btn', type: 'button', 'aria-pressed': String(t.id === state.tool), title: t.hint || t.label,
    onclick: async () => {
      if (t.pick) { const blob = await t.pick(); if (!blob) return; state.pendingImage = blob; }
      state.tool = t.id;
      toolButtons.forEach((b, i) => b.setAttribute('aria-pressed', String(tools[i].id === t.id)));
      stage.dataset.tool = t.id;
      draw();
    },
  }, t.label));

  let fontSelect;
  const fontNote = h('span', { class: 'muted font-note', 'aria-live': 'polite' });
  const styleBar = h('div', { class: 'row wrap gap-sm' }, fontNote,
    field('Text colour', h('input', { type: 'color', value: style.color, oninput: (e) => setStyle('color', e.target.value) })),
    field('Size', h('input', { type: 'number', min: 6, max: 144, value: style.size, class: 'w-num', oninput: (e) => setStyle('size', +e.target.value || 16) })),
    field('Font', fontSelect = h('select', { oninput: (e) => setStyle('font', e.target.value) }, ...FONTS.map((f) => h('option', { value: f }, fontLabel(f))))),
    field('Shape fill', h('input', { type: 'color', value: style.fill, oninput: (e) => setStyle('fill', e.target.value) })),
  );

  const canvasHolder = h('div', { class: 'stage-canvas' });
  const overlay = h('div', { class: 'stage-overlay' });
  const stage = h('div', { class: 'stage', 'data-tool': state.tool }, canvasHolder, overlay);
  const root = h('div', { class: 'editor' },
    h('div', { class: 'editor-bar' },
      h('div', { class: 'seg', role: 'group', 'aria-label': 'Tool' }, toolButtons),
      toolbarExtra || null,
      h('div', { class: 'row gap-sm' }, prev, pageLabel, next)),
    tools.some((t) => t.styled) ? styleBar : null,
    h('div', { class: 'stage-wrap' }, stage),
  );

  function field(label, input) { return h('label', { class: 'mini-field' }, h('span', {}, label), input); }

  function setStyle(k, v) {
    style[k] = v;
    const it = state.items.find((i) => i.id === state.selected);
    if (!it) return;
    if (it.type === 'text' && ['color', 'size', 'font'].includes(k)) {
      it[k] = v;
      if (k === 'size') it.h = Math.max(it.h, v * 1.3);
      if (k === 'font') delete it.srcFont; // the user picked a font: stop using the document's own
      noteFont(it);
    }
    if (['rect', 'ellipse'].includes(it.type) && k === 'fill') it.fill = v;
    draw();
  }

  async function go(n) {
    if (n < 1 || n > state.pages) return;
    state.page = n; state.selected = null;
    await paint();
  }

  async function paint() {
    const doc = await loadPdfJs(file);
    state.pages = doc.numPages;
    const page = await doc.getPage(state.page);
    const vp = page.getViewport({ scale: 1 });
    const maxW = Math.min(root.clientWidth || 800, 900) - 4;
    state.scale = Math.min(1.6, maxW / vp.width);
    state.vw = vp.width; state.vh = vp.height;
    const canvas = await renderPage(page, state.scale * devicePixelRatio);
    canvas.style.width = `${vp.width * state.scale}px`;
    canvas.style.height = `${vp.height * state.scale}px`;
    canvas.setAttribute('aria-label', `Page ${state.page}`);
    canvasHolder.replaceChildren(canvas);
    if (tools.some((t) => t.kind === 'edittext')) state.runs = page.rotate ? [] : await textRuns(page, vp, canvas, state.scale * devicePixelRatio);
    stage.style.width = canvas.style.width; stage.style.height = canvas.style.height;
    pageLabel.textContent = `Page ${state.page} of ${state.pages}`;
    prev.disabled = state.page === 1; next.disabled = state.page === state.pages;
    draw();
  }

  // ----- items -> DOM -----
  function draw() {
    const mine = state.items.filter((i) => i.page === state.page);
    const s = state.scale;
    const box = (b) => ({ left: `${b.x * s}px`, top: `${b.y * s}px`, width: `${b.w * s}px`, height: `${b.h * s}px` });
    const covers = mine.filter((i) => i.cover).map((i) => h('div', { class: 'cover', 'aria-hidden': 'true', style: { ...box(i.cover), background: i.cover.bg } }));
    const taken = new Set(mine.map((i) => i.run));
    const hits = state.tool && tools.find((t) => t.id === state.tool)?.kind === 'edittext'
      ? (state.runs || []).filter((r) => !taken.has(r.key)).map((r) => h('button', {
        class: 'text-hit', type: 'button', 'aria-label': `Edit text: ${r.str}`, style: box(r.box), onclick: () => editRun(r),
      })) : [];
    overlay.replaceChildren(...covers, ...hits, ...mine.map(itemEl));
    onChange(state.items);
  }

  function editRun(r) {
    const size = r.size;
    add({ type: 'text', run: r.key, x: r.box.x - 2, y: r.baseline - size * 1.05, w: r.box.w + 8, h: size * 1.3, text: r.str,
      color: r.color, size, font: r.font, srcFont: r.src ? { ...r.src, sample: r.str } : null, cover: { ...r.box, x: r.box.x - 1, w: r.box.w + 2, bg: r.bg } });
    draw();
    const t = overlay.querySelector('.selected .item-text');
    t.focus(); document.getSelection().selectAllChildren(t);
    if (fontSelect) fontSelect.value = r.font;
    noteFont(state.items.find((i) => i.id === state.selected));
  }

  async function noteFont(it) {
    if (!it || it.type !== 'text') { fontNote.textContent = ''; return; }
    const r = await resolveFont(it);
    it.preview = r.bytes ? await faceFor(r) : null;
    const el = overlay.querySelector('.selected .item-text');
    if (el && state.items.find((i) => i.id === state.selected) === it) { Object.assign(el.style, previewFont(it)); fontNote.textContent = r.label; }
  }

  function itemEl(it) {
    const s = state.scale;
    const el = h('div', {
      class: `item item-${it.type}${it.id === state.selected ? ' selected' : ''}`, tabindex: 0,
      'aria-label': `${it.type} item`, style: { left: `${it.x * s}px`, top: `${it.y * s}px`, width: `${it.w * s}px`, height: `${it.h * s}px` },
      onkeydown: (e) => {
        if (e.target !== el) return;
        if (e.key === 'Delete' || e.key === 'Backspace') { remove(it); e.preventDefault(); }
        const d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
        if (d) { it.x += d[0] * (e.shiftKey ? 10 : 2); it.y += d[1] * (e.shiftKey ? 10 : 2); e.preventDefault(); draw(); el.focus(); refocus(it); }
      },
    });
    if (it.type === 'text') {
      const t = h('div', { class: 'item-text', contenteditable: 'plaintext-only', spellcheck: 'false',
        style: { color: it.color, fontSize: `${it.size * s}px`, ...previewFont(it) } }, it.text);
      t.addEventListener('input', () => { it.text = t.innerText; noteFont(it); it.w = Math.max(it.w, t.scrollWidth / s); it.h = Math.max(it.size * 1.3, t.scrollHeight / s); onChange(state.items); });
      t.addEventListener('pointerdown', (e) => { e.stopPropagation(); select(it, false); noteFont(it); });
      el.append(h('span', { class: 'item-grip', title: 'Drag to move', 'aria-hidden': 'true' }), t);
    }
    if (it.type === 'image') el.append(h('img', { src: it.url, alt: 'Placed image', draggable: 'false' }));
    if (it.type === 'rect' || it.type === 'whiteout' || it.type === 'redact') el.style.background = it.type === 'whiteout' ? '#fff' : it.type === 'redact' ? '#000' : it.fill;
    if (it.type === 'ellipse') { el.style.background = it.fill; el.style.borderRadius = '50%'; }
    if (it.type === 'draw') {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', `0 0 ${it.w} ${it.h}`); svg.setAttribute('preserveAspectRatio', 'none');
      const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      p.setAttribute('d', it.path); p.setAttribute('fill', 'none'); p.setAttribute('stroke', it.color); p.setAttribute('stroke-width', it.stroke);
      p.setAttribute('stroke-linecap', 'round'); p.setAttribute('stroke-linejoin', 'round'); p.setAttribute('vector-effect', 'non-scaling-stroke');
      svg.append(p); el.append(svg);
    }
    if (it.type === 'crop') el.classList.add('item-crop');
    el.append(
      h('button', { class: 'item-del', type: 'button', 'aria-label': 'Remove item', onpointerdown: (e) => e.stopPropagation(), onclick: () => remove(it) }, '×'),
      h('span', { class: 'item-handle', 'aria-hidden': 'true', onpointerdown: (e) => startResize(e, it) }),
    );
    el.addEventListener('pointerdown', (e) => startMove(e, it));
    return el;
  }

  function refocus(it) { requestAnimationFrame(() => overlay.querySelector('.selected')?.focus()); void it; }
  function select(it, redraw = true) { if (state.selected === it.id) return; state.selected = it.id; if (redraw) { draw(); refocus(it); } }
  function remove(it) { state.items = state.items.filter((i) => i !== it); state.selected = null; draw(); }

  function pt(e) {
    const r = stage.getBoundingClientRect();
    return [Math.max(0, Math.min(state.vw, (e.clientX - r.left) / state.scale)), Math.max(0, Math.min(state.vh, (e.clientY - r.top) / state.scale))];
  }

  function drag(e, onMove, onEnd) {
    e.preventDefault();
    const move = (ev) => onMove(ev);
    const up = (ev) => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); onEnd?.(ev); };
    addEventListener('pointermove', move); addEventListener('pointerup', up);
  }

  function startMove(e, it) {
    if (e.button) return;
    select(it);
    const [sx, sy] = pt(e); const ox = it.x; const oy = it.y;
    drag(e, (ev) => { const [x, y] = pt(ev); it.x = Math.max(0, Math.min(state.vw - it.w, ox + x - sx)); it.y = Math.max(0, Math.min(state.vh - it.h, oy + y - sy)); draw(); }, () => refocus(it));
  }

  function startResize(e, it) {
    e.stopPropagation();
    const [sx, sy] = pt(e); const ow = it.w; const oh = it.h; const ratio = ow / oh;
    drag(e, (ev) => {
      const [x, y] = pt(ev);
      it.w = Math.max(8, ow + x - sx);
      it.h = it.type === 'image' && !ev.shiftKey ? it.w / ratio : Math.max(8, oh + y - sy);
      if (it.type === 'text') it.size = Math.max(6, Math.round(it.h / 1.3));
      draw();
    });
  }

  stage.addEventListener('pointerdown', (e) => {
    if (e.target !== overlay || e.button) return;
    const tool = tools.find((t) => t.id === state.tool);
    const [x, y] = pt(e);
    state.selected = null;
    if (tool.kind === 'text') {
      const it = add({ type: 'text', x, y: Math.max(0, y - style.size * 0.6), w: 160, h: style.size * 1.3, text: tool.text?.() ?? 'Text', color: style.color, size: style.size, font: style.font });
      e.preventDefault(); // keep the browser from moving focus off the new text box
      draw();
      const t = overlay.querySelector('.selected .item-text');
      t.focus(); document.getSelection().selectAllChildren(t);
      return void it;
    }
    if (tool.kind === 'image') {
      if (!state.pendingImage) return;
      const blob = state.pendingImage;
      createImageBitmap(blob).then((bmp) => {
        const w = Math.min(tool.width || 180, state.vw - x);
        add({ type: 'image', blob, url: URL.createObjectURL(blob), x, y, w, h: (w * bmp.height) / bmp.width });
        draw();
      });
      return;
    }
    if (tool.kind === 'box') {
      if (tool.single) state.items = state.items.filter((i) => i.type !== tool.type);
      const it = add({ type: tool.type, x, y, w: 1, h: 1, fill: style.fill });
      drag(e, (ev) => { const [x2, y2] = pt(ev); it.x = Math.min(x, x2); it.y = Math.min(y, y2); it.w = Math.abs(x2 - x); it.h = Math.abs(y2 - y); draw(); },
        () => { if (it.w < 4 || it.h < 4) remove(it); else draw(); });
      return;
    }
    if (tool.kind === 'draw') {
      const pts = [[x, y]];
      const it = add({ type: 'draw', x, y, w: 1, h: 1, color: style.color, stroke: style.stroke, path: '' });
      const update = () => {
        const xs = pts.map((p) => p[0]); const ys = pts.map((p) => p[1]);
        it.x = Math.min(...xs) - 2; it.y = Math.min(...ys) - 2; it.w = Math.max(...xs) - it.x + 4; it.h = Math.max(...ys) - it.y + 4;
        it.path = pts.map((p, i) => `${i ? 'L' : 'M'}${(p[0] - it.x).toFixed(1)} ${(p[1] - it.y).toFixed(1)}`).join(' ');
        draw();
      };
      drag(e, (ev) => { pts.push(pt(ev)); update(); }, () => { if (pts.length < 2) remove(it); });
    }
  });

  function add(it) { it.id = nextId++; it.page = state.page; state.items.push(it); state.selected = it.id; return it; }

  let lastW = 0; // repaint only when the width really changes; a repaint rebuilds items and drops focus
  new ResizeObserver(() => { const w = root.clientWidth; if (state.vw && Math.abs(w - lastW) > 20) { lastW = w; paint(); } else lastW ||= w; }).observe(root);
  return { el: root, ready: paint(), state, add: (it) => { add(it); draw(); }, redraw: draw };
}

/** Write text/image/shape/drawing items into a pdf-lib document (pages must match the source file). */
export async function applyItems(doc, items) {
  const fonts = {};
  for (const it of items) {
    const page = doc.getPage(it.page - 1);
    const { x: bx, y: by, width: pw, height: ph } = page.getCropBox();
    void pw;
    const X = (x) => bx + x;
    const Y = (y) => by + ph - y; // top-left -> PDF bottom-left
    if (it.cover) {
      const c = it.cover;
      page.drawRectangle({ x: X(c.x), y: Y(c.y + c.h), width: c.w, height: c.h, color: hexToRgb(c.bg) });
    }
    if (it.type === 'text' && it.text.trim()) {
      const r = await resolveFont(it);
      let font;
      if (r.bytes) {
        if (!fonts.kit) { doc.registerFontkit(window.fontkit); fonts.kit = true; }
        font = (fonts[r.key] ||= await doc.embedFont(r.bytes, { subset: false }));
      } else font = (fonts[it.font] ||= await doc.embedFont(StandardFonts[it.font] || StandardFonts.Helvetica));
      it.text.split('\n').forEach((line, i) => page.drawText(r.bytes ? line : safeText(font, line), {
        x: X(it.x + 2), y: Y(it.y + it.size * (1.05 + i * 1.2)), size: it.size, font, color: hexToRgb(it.color),
      }));
    }
    if (it.type === 'image') {
      const img = await embedImage(doc, it.blob);
      page.drawImage(img, { x: X(it.x), y: Y(it.y + it.h), width: it.w, height: it.h });
    }
    if (it.type === 'rect' || it.type === 'whiteout') page.drawRectangle({ x: X(it.x), y: Y(it.y + it.h), width: it.w, height: it.h, color: it.type === 'whiteout' ? rgb(1, 1, 1) : hexToRgb(it.fill) });
    if (it.type === 'ellipse') page.drawEllipse({ x: X(it.x + it.w / 2), y: Y(it.y + it.h / 2), xScale: it.w / 2, yScale: it.h / 2, color: hexToRgb(it.fill) });
    if (it.type === 'draw') page.drawSvgPath(it.path, { x: X(it.x), y: Y(it.y), borderColor: hexToRgb(it.color), borderWidth: it.stroke });
  }
}

// ---------- fonts ----------
const FAMILIES = { Helvetica: ['Helvetica', 'HelveticaBold', 'HelveticaOblique', 'HelveticaBoldOblique'], TimesRoman: ['TimesRoman', 'TimesRomanBold', 'TimesRomanItalic', 'TimesRomanBoldItalic'], Courier: ['Courier', 'CourierBold', 'CourierOblique', 'CourierBoldOblique'] };
const FONTS = Object.values(FAMILIES).flat();
const fontLabel = (f) => f.replace('TimesRoman', 'Times').replace(/(Bold)?(Oblique|Italic)?$/, (m, b, i) => (b ? ' Bold' : '') + (i ? ' Italic' : ''));
function cssFont(f = 'Helvetica') {
  const fam = f.startsWith('Times') ? 'Times New Roman, Times, serif' : f.startsWith('Courier') ? 'Courier New, monospace' : 'Helvetica, Arial, sans-serif';
  return { fontFamily: fam, fontWeight: /Bold/.test(f) ? '700' : '400', fontStyle: /Oblique|Italic/.test(f) ? 'italic' : 'normal' };
}
/** Closest standard font for a PDF font name + pdf.js generic family. */
export function matchFont(name = '', generic = '') {
  const fam = /courier|mono|consol|menlo/i.test(name) || generic === 'monospace' ? 'Courier'
    : /times|georgia|garamond|minion|cambria|palatino|book|serif/i.test(name.replace(/sans/i, '')) || generic === 'serif' ? 'TimesRoman' : 'Helvetica';
  const bold = /bold|black|heavy|semibold|demi/i.test(name); const ital = /italic|oblique/i.test(name);
  return FAMILIES[fam][(bold ? 1 : 0) + (ital ? 2 : 0)];
}

// ---------- existing text ----------
/** Group pdf.js text items into same-font runs on one baseline, with box, size, font and sampled colours. */
async function textRuns(page, vp, canvas, k) {
  const tc = await page.getTextContent();
  const g = canvas.getContext('2d', { willReadFrequently: true });
  const runs = [];
  let cur = null;
  tc.items.forEach((it, idx) => {
    const [a, b, c, d, e, f] = it.transform;
    if (!it.str || Math.abs(b) > 0.01 || Math.abs(c) > 0.01 || a <= 0) { cur = null; return; } // skip rotated/mirrored text
    const size = Math.abs(d) || Math.hypot(c, d);
    const [x, y] = vp.convertToViewportPoint(e, f);
    const gap = cur ? x - (cur.box.x + cur.box.w) : 0;
    if (cur && cur.fontName === it.fontName && Math.abs(cur.baseline - y) < size * 0.2 && gap > -size * 0.3 && gap < size * 0.6) {
      cur.str += (gap > size * 0.15 && !cur.str.endsWith(' ') && !it.str.startsWith(' ') ? ' ' : '') + it.str;
      cur.box.w = x + it.width - cur.box.x;
      return;
    }
    let fo = null;
    try { fo = page.commonObjs.has(it.fontName) ? page.commonObjs.get(it.fontName) : null; } catch { /* font not loaded */ }
    const name = fo?.name || '';
    cur = { key: `${page.pageNumber}:${idx}`, fontName: it.fontName, str: it.str, size, baseline: y,
      src: name ? { name, loadedName: fo.loadedName, data: fo.data || null } : null,
      font: matchFont(name, tc.styles[it.fontName]?.fontFamily), box: { x, y: y - size * 0.95, w: it.width, h: size * 1.25 } };
    runs.push(cur);
  });
  for (const r of runs) {
    const trimmed = r.str.replace(/\s+$/, '');
    // pdf.js widths include trailing spaces; a space is ~0.25em, so take that off (slightly under, to stay covering)
    if (trimmed.length < r.str.length) r.box.w = Math.max(r.box.w * 0.5, r.box.w - (r.str.length - trimmed.length) * r.size * 0.22);
    r.str = trimmed;
    Object.assign(r, sampleColours(g, r.box, k));
  }
  return runs.filter((r) => r.str.trim());
}

/** Background = median of pixels around the box; text = the pixel inside it farthest from that. */
function sampleColours(g, box, k) {
  const W = g.canvas.width; const H = g.canvas.height;
  const px = (x, y) => { const d = g.getImageData(Math.max(0, Math.min(W - 1, Math.round(x * k))), Math.max(0, Math.min(H - 1, Math.round(y * k))), 1, 1).data; return [d[0], d[1], d[2]]; };
  const ring = [];
  for (let i = 0; i <= 8; i++) { const x = box.x + (box.w * i) / 8; ring.push(px(x, box.y - 1), px(x, box.y + box.h + 1)); }
  ring.push(px(box.x - 2, box.y + box.h / 2), px(box.x + box.w + 2, box.y + box.h / 2));
  const med = (i) => ring.map((p) => p[i]).sort((a, b) => a - b)[ring.length >> 1];
  const bg = [med(0), med(1), med(2)];
  const x0 = Math.max(0, Math.floor(box.x * k)); const y0 = Math.max(0, Math.floor(box.y * k));
  const w = Math.max(1, Math.min(W - x0, Math.ceil(box.w * k))); const hh = Math.max(1, Math.min(H - y0, Math.ceil(box.h * k)));
  const d = g.getImageData(x0, y0, w, hh).data;
  let best = [0, 0, 0]; let far = -1;
  for (let i = 0; i < d.length; i += 4) {
    const dist = Math.abs(d[i] - bg[0]) + Math.abs(d[i + 1] - bg[1]) + Math.abs(d[i + 2] - bg[2]);
    if (dist > far) { far = dist; best = [d[i], d[i + 1], d[i + 2]]; }
  }
  const hex = (c) => '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('');
  return { bg: hex(bg), color: hex(best) };
}

// ---------- which font to write edited text in ----------
const kitCache = new Map(); // key -> fontkit font | null
async function kit(key, getBytes) {
  if (!kitCache.has(key)) {
    kitCache.set(key, (async () => {
      try { const bytes = await getBytes(); if (!bytes) return null; return { bytes, font: window.fontkit.create(bytes) }; } catch { return null; }
    })());
  }
  return kitCache.get(key);
}
const covers = (k, text) => [...text].every((ch) => /\s/.test(ch) || k.font.hasGlyphForCodePoint(ch.codePointAt(0)));

/**
 * 1. the font embedded in the PDF, if it maps the original text correctly and has every new letter
 *    (embedded fonts are usually subsets);  2. the same font installed on this Mac;  3. a standard font.
 */
export async function resolveFont(it) {
  const std = { label: `Font: ${fontLabel(it.font)} (standard stand-in)` };
  const src = it.srcFont;
  if (!src || !window.fontkit) return std;
  const bare = src.name.replace(/^[A-Z]{6}\+/, '').replace(/-\d{3,6}$/, ''); // "ABCDEF+Georgia", "Georgia-9742" (pdf-lib)
  if (src.data) {
    const k = await kit(`pdf:${src.loadedName}`, () => src.data);
    if (k && covers(k, src.sample) && covers(k, it.text)) return { key: `pdf:${src.loadedName}`, bytes: k.bytes, label: `Font: ${bare} (from this PDF)` };
  }
  const k = await kit(`sys:${bare}`, () => installedFont(bare));
  if (k && covers(k, it.text)) return { key: `sys:${bare}`, bytes: k.bytes, label: `Font: ${bare} (installed on this device${src.data ? '; the PDF’s copy lacks some letters' : ''})` };
  if (!k && !window.queryLocalFonts) return { label: `Font: ${fontLabel(it.font)} (standard stand-in; this browser can’t read installed fonts)` };
  if (!k && /^(helvetica|times|courier)/i.test(bare)) return { label: `Font: ${fontLabel(it.font)} (a standard PDF font, same as the original)` };
  return { label: `Font: ${fontLabel(it.font)} (standard stand-in: ${bare} ${k ? 'lacks some letters' : 'isn’t installed'})` };
}

const previewFont = (it) => (it.preview ? { fontFamily: `"${it.preview}", ${cssFont(it.font).fontFamily}`, fontWeight: 'normal', fontStyle: 'normal' } : cssFont(it.font));
const faces = new Map();
/** Load the chosen font into the page so the preview matches what will be written. */
function faceFor(r) {
  if (!faces.has(r.key)) {
    const name = `edit-${faces.size}`;
    faces.set(r.key, new FontFace(name, r.bytes).load().then((f) => { document.fonts.add(f); return name; }).catch(() => null));
  }
  return faces.get(r.key);
}

// "ABCDEF+Arial,Bold" / "Arial-BoldMT" / "Arial Bold" -> "arialbold"
const normFont = (n) => String(n).toLowerCase().replace(/[^a-z0-9]/g, '').replace(/(mt|ps)$/, '');
let localFonts;
/** The same font from this device, via the Local Font Access API (Chrome/Edge; asks permission once). */
async function installedFont(name) {
  if (!window.queryLocalFonts) return null;
  try {
    localFonts ||= await window.queryLocalFonts();
    const want = normFont(name);
    const f = localFonts.find((x) => normFont(x.postscriptName) === want) || localFonts.find((x) => normFont(x.fullName) === want);
    return f ? new Uint8Array(await (await f.blob()).arrayBuffer()) : null;
  } catch { localFonts = null; return null; } // permission refused or API unavailable
}
