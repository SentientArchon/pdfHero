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
    },
  }, t.label));

  const styleBar = h('div', { class: 'row wrap gap-sm' },
    field('Text colour', h('input', { type: 'color', value: style.color, oninput: (e) => setStyle('color', e.target.value) })),
    field('Size', h('input', { type: 'number', min: 6, max: 144, value: style.size, class: 'w-num', oninput: (e) => setStyle('size', +e.target.value || 16) })),
    field('Font', h('select', { oninput: (e) => setStyle('font', e.target.value) }, ...['Helvetica', 'TimesRoman', 'Courier'].map((f) => h('option', { value: f }, f.replace('TimesRoman', 'Times'))))),
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
    if (it.type === 'text' && ['color', 'size', 'font'].includes(k)) it[k] = v;
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
    stage.style.width = canvas.style.width; stage.style.height = canvas.style.height;
    pageLabel.textContent = `Page ${state.page} of ${state.pages}`;
    prev.disabled = state.page === 1; next.disabled = state.page === state.pages;
    draw();
  }

  // ----- items -> DOM -----
  function draw() {
    overlay.replaceChildren(...state.items.filter((i) => i.page === state.page).map(itemEl));
    onChange(state.items);
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
        style: { color: it.color, fontSize: `${it.size * s}px`, fontFamily: cssFont(it.font) } }, it.text);
      t.addEventListener('input', () => { it.text = t.innerText; it.w = Math.max(it.w, t.scrollWidth / s); it.h = Math.max(it.size * 1.3, t.scrollHeight / s); onChange(state.items); });
      t.addEventListener('pointerdown', (e) => { e.stopPropagation(); select(it, false); });
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

  const cssFont = (f) => ({ Helvetica: 'Helvetica, Arial, sans-serif', TimesRoman: 'Times New Roman, Times, serif', Courier: 'Courier New, monospace' }[f]);
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
    if (it.type === 'text' && it.text.trim()) {
      const font = (fonts[it.font] ||= await doc.embedFont(StandardFonts[it.font] || StandardFonts.Helvetica));
      it.text.split('\n').forEach((line, i) => page.drawText(safeText(font, line), {
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
