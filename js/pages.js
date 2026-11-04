// Page thumbnail grid: select pages, or reorder/rotate/delete/insert blanks (organize).
import { h, thumbnail, loadPdfJs, loadPdfLib, PDFDocument, degrees, pdfBlob } from './lib.js';

export async function pageGrid(files, { mode = 'select', selectLabel = 'Selected', onChange = () => {} } = {}) {
  const pages = [];
  for (const file of files) {
    const doc = await loadPdfJs(file);
    for (let i = 0; i < doc.numPages; i++) pages.push({ file, index: i, rotation: 0, selected: false });
  }
  const grid = h('ol', { class: `page-grid mode-${mode}`, 'aria-label': 'Pages' });
  const io = new IntersectionObserver((entries) => entries.forEach((en) => {
    if (!en.isIntersecting) return;
    io.unobserve(en.target);
    const p = en.target._page;
    if (p.blank) return;
    thumbnail(p.file, p.index + 1, 140).then((c) => { c.setAttribute('aria-hidden', 'true'); en.target.querySelector('.pg-img').replaceChildren(c); });
  }), { rootMargin: '400px' });

  let dragFrom = null;
  function paint() {
    grid.replaceChildren(...pages.map((p, i) => {
      const img = h('div', { class: 'pg-img', style: { transform: `rotate(${p.rotation}deg)` } }, p.blank ? h('span', { class: 'muted' }, 'blank') : null);
      const label = `Page ${i + 1}${files.length > 1 && !p.blank ? ` (${p.file.name} p${p.index + 1})` : ''}`;
      let li;
      if (mode === 'select') {
        li = h('li', { class: 'pg' }, h('button', {
          class: 'pg-btn', type: 'button', 'aria-pressed': String(p.selected), 'aria-label': `${label}, ${p.selected ? selectLabel : 'not selected'}`,
          onclick: () => { p.selected = !p.selected; paint(); onChange(pages); },
        }, img, h('span', { class: 'pg-no' }, i + 1)));
      } else {
        const act = (txt, aria, fn) => h('button', { class: 'btn ghost xs', type: 'button', 'aria-label': `${aria} ${label}`, onclick: () => { fn(); paint(); onChange(pages); } }, txt);
        li = h('li', { class: 'pg', draggable: 'true' }, img, h('span', { class: 'pg-no' }, i + 1),
          h('div', { class: 'pg-actions' },
            act('←', 'Move earlier', () => i > 0 && pages.splice(i - 1, 0, ...pages.splice(i, 1))),
            act('⟳', 'Rotate', () => { p.rotation = (p.rotation + 90) % 360; }),
            act('+', 'Insert blank page after', () => pages.splice(i + 1, 0, { blank: true, rotation: 0, ref: p })),
            act('×', 'Delete', () => pages.splice(i, 1)),
            act('→', 'Move later', () => i < pages.length - 1 && pages.splice(i + 1, 0, ...pages.splice(i, 1)))));
        li.addEventListener('dragstart', (e) => { dragFrom = i; e.dataTransfer.effectAllowed = 'move'; li.classList.add('dragging'); });
        li.addEventListener('dragend', () => li.classList.remove('dragging'));
        li.addEventListener('dragover', (e) => { e.preventDefault(); li.classList.add('drop-target'); });
        li.addEventListener('dragleave', () => li.classList.remove('drop-target'));
        li.addEventListener('drop', (e) => {
          e.preventDefault();
          if (dragFrom == null || dragFrom === i) return;
          pages.splice(i, 0, ...pages.splice(dragFrom, 1)); dragFrom = null; paint(); onChange(pages);
        });
      }
      li._page = p;
      io.observe(li);
      return li;
    }));
  }
  paint();
  return { el: grid, pages, repaint: paint };
}

/** Assemble a new PDF from a page list (from pageGrid or built by hand). */
export async function buildFromPages(pages) {
  const out = await PDFDocument.create();
  const srcs = new Map();
  let lastSize = [595.28, 841.89];
  for (const p of pages) {
    if (p.blank) {
      const pg = out.addPage(lastSize);
      if (p.rotation) pg.setRotation(degrees(p.rotation));
      continue;
    }
    if (!srcs.has(p.file)) srcs.set(p.file, await loadPdfLib(p.file));
    const [pg] = await out.copyPages(srcs.get(p.file), [p.index]);
    if (p.rotation) pg.setRotation(degrees((pg.getRotation().angle + p.rotation) % 360));
    lastSize = [pg.getWidth(), pg.getHeight()];
    out.addPage(pg);
  }
  return pdfBlob(out);
}
