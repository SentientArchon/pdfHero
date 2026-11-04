import { h, loadPdfLib, PDFDocument, pdfBlob, parseRanges, parseRangeGroups, baseName, UserError, embedImage, canvasBlob } from '../lib.js';
import { pageGrid, buildFromPages } from '../pages.js';

const selectedSummary = (pages) => pages.filter((p) => p.selected).length;

export default [
  {
    id: 'merge', cat: 'organize', icon: '⧉', name: 'Merge PDF', action: 'Merge',
    desc: 'Join several PDFs into one, in the order you choose.', multiple: true,
    async run(files) {
      if (files.length < 2) throw new UserError('Add at least two PDFs to merge.');
      const out = await PDFDocument.create();
      for (const f of files) {
        const src = await loadPdfLib(f);
        (await out.copyPages(src, src.getPageIndices())).forEach((p) => out.addPage(p));
      }
      return [{ name: 'merged.pdf', blob: await pdfBlob(out) }];
    },
  },
  {
    id: 'split', cat: 'organize', icon: '✂', name: 'Split PDF', action: 'Split',
    desc: 'Cut a PDF into separate files by page ranges, every page, or fixed chunks.',
    options: () => [
      { key: 'mode', label: 'Split by', type: 'seg', choices: [['ranges', 'Ranges'], ['each', 'Every page'], ['chunk', 'Every N pages']], default: 'ranges' },
      { key: 'ranges', label: 'Ranges', placeholder: '1-3, 4-6, 7', default: '1-1', help: 'Each comma-separated range becomes one file.', show: (o) => o.mode === 'ranges' },
      { key: 'n', label: 'Pages per file', type: 'number', min: 1, default: 2, show: (o) => o.mode === 'chunk' },
      { key: 'join', label: 'Put all ranges in one PDF', type: 'checkbox', show: (o) => o.mode === 'ranges' },
    ],
    async run([file], o) {
      const src = await loadPdfLib(file);
      const total = src.getPageCount();
      let groups;
      if (o.mode === 'each') groups = [...Array(total).keys()].map((i) => [i]);
      else if (o.mode === 'chunk') {
        const n = Math.max(1, o.n | 0); groups = [];
        for (let i = 0; i < total; i += n) groups.push([...Array(Math.min(n, total - i)).keys()].map((k) => i + k));
      } else groups = parseRangeGroups(o.ranges, total);
      if (o.mode === 'ranges' && o.join) groups = [groups.flat()];
      const results = [];
      for (const g of groups) {
        const out = await PDFDocument.create();
        (await out.copyPages(src, g)).forEach((p) => out.addPage(p));
        const label = g.length === 1 ? `${g[0] + 1}` : `${g[0] + 1}-${g[g.length - 1] + 1}`;
        results.push({ name: `${baseName(file.name)}_${label}.pdf`, blob: await pdfBlob(out) });
      }
      return results;
    },
  },
  ...['remove', 'extract'].map((kind) => ({
    id: kind, cat: 'organize', icon: kind === 'remove' ? '⊟' : '⊞',
    name: kind === 'remove' ? 'Remove pages' : 'Extract pages', action: kind === 'remove' ? 'Remove selected' : 'Extract selected',
    desc: kind === 'remove' ? 'Click the pages you want gone, then save the rest.' : 'Click the pages you want to keep as a new PDF.',
    options: () => [{ key: 'ranges', label: 'Or type pages', placeholder: 'e.g. 2, 5-7', help: 'Used instead of the clicked pages when filled.' },
      ...(kind === 'extract' ? [{ key: 'separate', label: 'Each page as its own file', type: 'checkbox' }] : [])],
    async mount(ctx) {
      const count = h('p', { class: 'muted' }, 'No pages selected.');
      const grid = await pageGrid(ctx.files, { selectLabel: kind === 'remove' ? 'will be removed' : 'will be extracted', onChange: (p) => { count.textContent = `${selectedSummary(p)} page(s) selected.`; } });
      return { el: h('div', {}, count, grid.el), grid };
    },
    async run([file], o, ctx) {
      const pages = ctx.custom.grid.pages;
      const picked = o.ranges.trim() ? new Set(parseRanges(o.ranges, pages.length)) : new Set(pages.map((p, i) => (p.selected ? i : -1)).filter((i) => i >= 0));
      if (!picked.size) throw new UserError('Select at least one page.');
      const keep = pages.filter((_, i) => (kind === 'remove' ? !picked.has(i) : picked.has(i)));
      if (!keep.length) throw new UserError('That would leave no pages.');
      if (kind === 'extract' && o.separate) return Promise.all(keep.map(async (p) => ({ name: `${baseName(file.name)}_p${p.index + 1}.pdf`, blob: await buildFromPages([p]) })));
      return [{ name: `${baseName(file.name)}_${kind === 'remove' ? 'trimmed' : 'extract'}.pdf`, blob: await buildFromPages(keep) }];
    },
  })),
  {
    id: 'organize', cat: 'organize', icon: '▦', name: 'Organize PDF', action: 'Save order',
    desc: 'Drag pages into a new order, rotate, delete, insert blanks. Add more PDFs to combine them.', multiple: true,
    async mount(ctx) {
      const grid = await pageGrid(ctx.files, { mode: 'organize' });
      return { el: h('div', {}, h('p', { class: 'muted' }, 'Drag a page to move it, or use its buttons.'), grid.el), grid };
    },
    async run(files, o, ctx) {
      if (!ctx.custom.grid.pages.length) throw new UserError('There are no pages left.');
      return [{ name: `${baseName(files[0].name)}_organized.pdf`, blob: await buildFromPages(ctx.custom.grid.pages) }];
    },
  },
  {
    id: 'scan', cat: 'organize', icon: '◉', name: 'Scan to PDF', action: 'Make PDF', minFiles: 0, multiple: true, accept: 'image/*',
    desc: 'Use your camera (or photos) to capture paper pages and turn them into a PDF.',
    options: () => [{ key: 'filter', label: 'Look', type: 'seg', choices: [['doc', 'Document'], ['gray', 'Greyscale'], ['color', 'Colour']], default: 'doc' }],
    async mount(ctx) {
      const shots = ctx.scanShots ||= [];
      const video = h('video', { autoplay: true, playsinline: true, muted: true, class: 'cam', 'aria-label': 'Camera preview' });
      const list = h('ol', { class: 'shots', 'aria-label': 'Captured pages' });
      const status = h('p', { class: 'muted', 'aria-live': 'polite' });
      const paint = () => {
        list.replaceChildren(...shots.map((b, i) => h('li', {}, h('img', { src: URL.createObjectURL(b), alt: `Captured page ${i + 1}` }),
          h('button', { class: 'btn ghost xs', type: 'button', 'aria-label': `Remove page ${i + 1}`, onclick: () => { shots.splice(i, 1); paint(); } }, '×'))));
        status.textContent = `${shots.length + ctx.files.length} page(s) ready.`;
      };
      let stream;
      const start = h('button', { class: 'btn secondary', type: 'button', onclick: async () => {
        try {
          stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 2480 } } });
          video.srcObject = stream; snap.disabled = false;
        } catch { status.textContent = 'No camera available. You can still add photos with “Choose files”.'; }
      } }, 'Start camera');
      const snap = h('button', { class: 'btn primary', type: 'button', disabled: true, onclick: async () => {
        const c = h('canvas', { width: video.videoWidth, height: video.videoHeight });
        c.getContext('2d').drawImage(video, 0, 0);
        shots.push(await canvasBlob(c, 'image/jpeg', 0.9)); paint();
      } }, 'Capture page');
      addEventListener('hashchange', () => stream?.getTracks().forEach((t) => t.stop()), { once: true });
      paint();
      return { el: h('div', { class: 'scan' }, h('div', { class: 'row gap-sm' }, start, snap), video, status, list), shots };
    },
    async run(files, o, ctx) {
      const imgs = [...(ctx.custom?.shots || []), ...files];
      if (!imgs.length) throw new UserError('Capture or add at least one page.');
      const out = await PDFDocument.create();
      for (const blob of imgs) {
        const bmp = await createImageBitmap(blob);
        const c = h('canvas', { width: bmp.width, height: bmp.height });
        const g = c.getContext('2d');
        if (o.filter !== 'color') g.filter = o.filter === 'doc' ? 'grayscale(1) contrast(1.6) brightness(1.1)' : 'grayscale(1)';
        g.drawImage(bmp, 0, 0);
        const img = await embedImage(out, await canvasBlob(c, 'image/jpeg', 0.85));
        const w = 595.28; const hgt = (w * bmp.height) / bmp.width; // A4 width, keep aspect
        out.addPage([w, hgt]).drawImage(img, { x: 0, y: 0, width: w, height: hgt });
      }
      return [{ name: 'scan.pdf', blob: await pdfBlob(out) }];
    },
  },
];
