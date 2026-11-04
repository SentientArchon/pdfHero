import { h, api, PDFDocument, pdfBlob, embedImage, baseName, UserError, loadPdfJs, renderPage, canvasBlob, sizeLabel, parseRanges } from '../lib.js';

/** A tool whose work is done by the local helper (POST /api/<op>), one file at a time. */
export function serverTool({ op, outSuffix = '', query = () => ({}), headers = () => ({}), ...def }) {
  return {
    server: op, multiple: true, ...def,
    async run(files, o, ctx) {
      const results = [];
      for (const [i, f] of files.entries()) {
        ctx.progress(`Working on ${f.name} (${i + 1} of ${files.length})…`);
        const blob = await api(op, f, query(o, ctx), headers(o, ctx));
        results.push({ name: `${baseName(f.name)}${outSuffix}.${def.ext || 'pdf'}`, blob, before: f.size });
      }
      return results;
    },
  };
}

const PAGE = { a4: [595.28, 841.89], letter: [612, 792] };

export default [
  // ---------- optimize ----------
  serverTool({
    id: 'compress', cat: 'optimize', icon: '⇲', name: 'Compress PDF', action: 'Compress', op: 'compress', outSuffix: '_compressed',
    desc: 'Shrink a PDF by re-encoding its images, with a choice of how hard to squeeze.',
    options: () => [{ key: 'level', label: 'Compression', type: 'seg', choices: [['low', 'Light'], ['recommended', 'Balanced'], ['extreme', 'Strong']], default: 'recommended',
      help: 'Strong gives the smallest file with visibly softer images.' }],
    query: (o) => ({ level: o.level }),
    report: (rs) => rs.map((r) => `${sizeLabel(r.before)} → ${sizeLabel(r.blob.size)} (${r.blob.size < r.before ? '−' + Math.round(100 - (r.blob.size / r.before) * 100) : '+' + Math.round((r.blob.size / r.before) * 100 - 100)}%)`).join(' · '),
  }),
  serverTool({
    id: 'repair', cat: 'optimize', icon: '⚕', name: 'Repair PDF', action: 'Repair', op: 'repair', outSuffix: '_repaired',
    desc: 'Rebuild a damaged PDF’s structure so it opens again, recovering what can be recovered.',
  }),
  {
    ...serverTool({
      id: 'ocr', cat: 'optimize', icon: '⌕', name: 'OCR PDF', action: 'Recognise text', op: 'ocr', outSuffix: '_ocr',
      desc: 'Turn scanned pages into searchable, selectable text. Pages that already have text are left alone.',
      query: (o) => ({ lang: [o.lang, o.lang2].filter(Boolean).join('+') }),
    }),
    options: (ctx) => {
      const langs = (ctx.health?.langs?.length ? ctx.health.langs : ['eng']).map((l) => [l, l]);
      return [
        { key: 'lang', label: 'Document language', type: 'select', choices: langs, default: langs.find((l) => l[0] === 'eng')?.[0] || langs[0][0], help: 'Tesseract language codes, e.g. eng, spa, fra, deu.' },
        { key: 'lang2', label: 'Second language (optional)', type: 'select', choices: [['', 'None'], ...langs], default: '' },
      ];
    },
  },

  // ---------- to PDF ----------
  {
    id: 'jpg-to-pdf', cat: 'to', icon: '🖼', name: 'JPG to PDF', action: 'Convert', multiple: true, accept: 'image/*',
    desc: 'Put photos and images (JPG, PNG, WebP, GIF…) into a PDF, one per page.',
    options: () => [
      { key: 'size', label: 'Page size', type: 'select', choices: [['fit', 'Same as image'], ['a4', 'A4'], ['letter', 'US Letter']], default: 'fit' },
      { key: 'orient', label: 'Orientation', type: 'seg', choices: [['auto', 'Auto'], ['portrait', 'Portrait'], ['landscape', 'Landscape']], default: 'auto', show: (o) => o.size !== 'fit' },
      { key: 'margin', label: 'Margin', type: 'seg', choices: [['0', 'None'], ['20', 'Small'], ['50', 'Large']], default: '0' },
      { key: 'merge', label: 'All images in one PDF', type: 'checkbox', default: true },
    ],
    async run(files, o) {
      const make = async (list) => {
        const doc = await PDFDocument.create();
        for (const f of list) {
          const img = await embedImage(doc, f);
          const m = +o.margin;
          let [pw, ph] = o.size === 'fit' ? [img.width * 0.75 + 2 * m, img.height * 0.75 + 2 * m] : PAGE[o.size];
          const land = o.orient === 'landscape' || (o.orient === 'auto' && img.width > img.height);
          if (o.size !== 'fit' && land) [pw, ph] = [ph, pw];
          const k = Math.min((pw - 2 * m) / img.width, (ph - 2 * m) / img.height);
          const w = img.width * k; const hh = img.height * k;
          doc.addPage([pw, ph]).drawImage(img, { x: (pw - w) / 2, y: (ph - hh) / 2, width: w, height: hh });
        }
        return pdfBlob(doc);
      };
      if (o.merge) return [{ name: files.length === 1 ? `${baseName(files[0].name)}.pdf` : 'images.pdf', blob: await make(files) }];
      return Promise.all(files.map(async (f) => ({ name: `${baseName(f.name)}.pdf`, blob: await make([f]) })));
    },
  },
  ...[['word', 'Word', '.doc,.docx,.odt,.rtf,.txt', 'W'], ['powerpoint', 'PowerPoint', '.ppt,.pptx,.odp,.key', 'P'], ['excel', 'Excel', '.xls,.xlsx,.ods,.csv', 'X']].map(([id, label, accept, icon]) => serverTool({
    id: `${id}-to-pdf`, cat: 'to', icon, name: `${label} to PDF`, action: 'Convert', op: 'office2pdf', accept,
    desc: `Convert ${label} documents (${accept.replaceAll(',', ' ')}) into PDF, keeping their layout.`,
  })),
  {
    ...serverTool({ id: 'html-to-pdf', cat: 'to', icon: '⟨⟩', name: 'HTML to PDF', action: 'Convert', op: 'html2pdf', accept: '.html,.htm', minFiles: 0, multiple: false,
      desc: 'Save a web page (by address) or an HTML file as a PDF.' }),
    options: () => [{ key: 'url', label: 'Web page address', type: 'url', placeholder: 'https://example.com', help: 'Leave empty to convert the HTML file you chose instead. The page is fetched directly by this computer.' }],
    async run(files, o) {
      if (!o.url && !files[0]) throw new UserError('Type a web address or choose an HTML file.');
      if (o.url && !/^https?:\/\//i.test(o.url)) throw new UserError('The address must start with http:// or https://');
      const blob = await api('html2pdf', o.url ? null : files[0], o.url ? { url: o.url } : {});
      return [{ name: o.url ? `${new URL(o.url).hostname}.pdf` : `${baseName(files[0].name)}.pdf`, blob }];
    },
  },

  // ---------- from PDF ----------
  {
    id: 'pdf-to-jpg', cat: 'from', icon: '▣', name: 'PDF to JPG', action: 'Convert',
    desc: 'Save every page (or the pages you pick) as JPG or PNG images.',
    options: () => [
      { key: 'fmt', label: 'Format', type: 'seg', choices: [['jpeg', 'JPG'], ['png', 'PNG']], default: 'jpeg' },
      { key: 'dpi', label: 'Quality', type: 'seg', choices: [['96', 'Screen'], ['150', 'Normal'], ['300', 'High']], default: '150' },
      { key: 'pages', label: 'Pages (empty = all)', placeholder: '1-3, 8' },
    ],
    async run([f], o, ctx) {
      const doc = await loadPdfJs(f);
      const idx = o.pages.trim() ? parseRanges(o.pages, doc.numPages) : [...Array(doc.numPages).keys()];
      const out = [];
      for (const i of idx) {
        ctx.progress(`Page ${i + 1} of ${doc.numPages}…`);
        const c = await renderPage(await doc.getPage(i + 1), +o.dpi / 72);
        if (o.fmt === 'jpeg') { const g = c.getContext('2d'); g.globalCompositeOperation = 'destination-over'; g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); }
        out.push({ name: `${baseName(f.name)}_page${String(i + 1).padStart(3, '0')}.${o.fmt === 'jpeg' ? 'jpg' : 'png'}`, blob: await canvasBlob(c, `image/${o.fmt}`, 0.9) });
        c.width = 0;
      }
      return out;
    },
  },
  serverTool({ id: 'pdf-to-word', cat: 'from', icon: 'W', name: 'PDF to Word', action: 'Convert', op: 'pdf2word', ext: 'docx',
    desc: 'Turn a PDF into an editable Word document. Scans need OCR first.' }),
  serverTool({ id: 'pdf-to-powerpoint', cat: 'from', icon: 'P', name: 'PDF to PowerPoint', action: 'Convert', op: 'pdf2ppt', ext: 'pptx',
    desc: 'Make a slide deck with one slide per PDF page (pages become slide images).' }),
  serverTool({ id: 'pdf-to-excel', cat: 'from', icon: 'X', name: 'PDF to Excel', action: 'Convert', op: 'pdf2excel', ext: 'xlsx',
    desc: 'Pull the tables out of a PDF into a spreadsheet, one sheet per table.' }),
  serverTool({ id: 'pdf-to-pdfa', cat: 'from', icon: 'A', name: 'PDF to PDF/A', action: 'Convert', op: 'pdfa', outSuffix: '_pdfa',
    desc: 'Convert to PDF/A, the archive format meant to open the same way decades from now.',
    options: () => [{ key: 'level', label: 'Conformance', type: 'seg', choices: [['1b', 'PDF/A-1b'], ['2b', 'PDF/A-2b'], ['3b', 'PDF/A-3b']], default: '2b' }],
    query: (o) => ({ level: o.level }) }),

  // ---------- text ----------
  {
    id: 'pdf-to-markdown', cat: 'intel', icon: 'M↓', name: 'PDF to Markdown', action: 'Convert',
    desc: 'Extract the text as Markdown, with headings guessed from font size. Good for notes and LLM-ready text.',
    async run([f], o, ctx) {
      const md = await pdfToMarkdown(f, ctx.progress);
      if (!md.trim()) throw new UserError('No text found. If this is a scan, run OCR PDF first.');
      return [{ name: `${baseName(f.name)}.md`, blob: new Blob([md], { type: 'text/markdown' }), view: h('pre', { class: 'preview', tabindex: 0 }, md.slice(0, 4000) + (md.length > 4000 ? '\n…' : '')) }];
    },
  },
];

export async function pageLines(page) {
  const tc = await page.getTextContent();
  const lines = [];
  for (const it of tc.items) {
    if (!it.str && !it.hasEOL) continue;
    const y = Math.round(it.transform[5]); const size = Math.round(Math.hypot(it.transform[2], it.transform[3]));
    let line = lines.find((l) => Math.abs(l.y - y) <= Math.max(2, size * 0.3));
    if (!line) lines.push(line = { y, size, parts: [] });
    line.size = Math.max(line.size, size);
    line.parts.push({ x: it.transform[4], str: it.str, w: it.width });
  }
  lines.sort((a, b) => b.y - a.y);
  return lines.map((l) => {
    l.parts.sort((a, b) => a.x - b.x);
    let text = ''; let end = null;
    for (const p of l.parts) { if (end != null && p.x - end > l.size * 0.2 && !text.endsWith(' ') && !p.str.startsWith(' ')) text += ' '; text += p.str; end = p.x + p.w; }
    return { y: l.y, size: l.size, text: text.trim() };
  }).filter((l) => l.text);
}

async function pdfToMarkdown(file, progress) {
  const doc = await loadPdfJs(file);
  const all = [];
  for (let i = 1; i <= doc.numPages; i++) { progress(`Reading page ${i} of ${doc.numPages}…`); all.push(await pageLines(await doc.getPage(i))); }
  // body size = the size carrying the most characters
  const chars = {};
  for (const l of all.flat()) chars[l.size] = (chars[l.size] || 0) + l.text.length;
  const body = +Object.entries(chars).sort((a, b) => b[1] - a[1])[0]?.[0] || 10;
  const out = [];
  for (const lines of all) {
    let para = [];
    const flush = () => { if (para.length) out.push(para.join(' ').replace(/-\s(?=[a-z])/g, '')); para = []; };
    lines.forEach((l, k) => {
      const gap = k ? lines[k - 1].y - l.y : 0;
      const level = l.size >= body * 1.8 ? 1 : l.size >= body * 1.4 ? 2 : l.size >= body * 1.15 ? 3 : 0;
      if (level) { flush(); out.push(`${'#'.repeat(level)} ${l.text}`); return; }
      const bullet = l.text.match(/^([•◦▪●\-*]|\d+[.)])\s+(.*)/);
      if (bullet) { flush(); out.push(/\d/.test(bullet[1]) ? `${parseInt(bullet[1], 10)}. ${bullet[2]}` : `- ${bullet[2]}`); return; }
      if (gap > l.size * 1.8) flush();
      para.push(l.text);
    });
    flush();
  }
  return out.join('\n\n') + '\n';
}
