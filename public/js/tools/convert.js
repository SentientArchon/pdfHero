import { h, PDFDocument, pdfBlob, embedImage, baseName, UserError, loadPdfJs, renderPage, canvasBlob, sizeLabel, parseRanges, bytesOf } from '../lib.js';
import { gs, qpdf, COMPRESS, pdfa, ocrPdf, OCR_LANGS, pdfToDocx, pdfToXlsx, pdfToPptx } from '../engines/pdf-engines.js';
import { printFrame, docxHtml, sheetHtml, pptxHtml, htmlFile } from '../engines/office.js';

const MIME = { pdf: 'application/pdf' };
/** A tool that handles each chosen file on its own with `convert(file, opts, ctx) -> Blob | bytes`. */
export function perFile({ convert, outSuffix = '', ext = 'pdf', ...def }) {
  return {
    multiple: true, ...def,
    async run(files, o, ctx) {
      const results = [];
      for (const [i, f] of files.entries()) {
        ctx.progress(`Working on ${f.name} (${i + 1} of ${files.length})…`);
        const out = await convert(f, o, ctx);
        const blob = out instanceof Blob ? out : new Blob([out], { type: MIME[ext] || 'application/octet-stream' });
        results.push({ name: `${baseName(f.name)}${outSuffix}.${ext}`, blob, before: f.size });
      }
      return results;
    },
  };
}

/** Office/HTML -> preview frame + "Save as PDF" through the browser's print dialog. */
function printTool({ make, ...def }) {
  return {
    ...def,
    async run([f], o, ctx) {
      ctx.progress('Laying out the document…');
      const html = await make(f, o);
      const frame = printFrame(html, `Preview of ${f.name}`);
      return [{ name: `${baseName(f.name)}.pdf`, print: frame, view: h('div', { class: 'print-wrap' }, frame) }];
    },
  };
}

const PAGE = { a4: [595.28, 841.89], letter: [612, 792] };

export default [
  // ---------- optimize ----------
  perFile({
    id: 'compress', cat: 'optimize', icon: '⇲', name: 'Compress PDF', action: 'Compress', outSuffix: '_compressed',
    convert: async (f, o) => gs(await bytesOf(f), ['-dCompatibilityLevel=1.5', `-dPDFSETTINGS=${COMPRESS[o.level] || '/ebook'}`, '-dDetectDuplicateImages=true']),
    desc: 'Shrink a PDF by re-encoding its images, with a choice of how hard to squeeze.',
    options: () => [{ key: 'level', label: 'Compression', type: 'seg', choices: [['low', 'Light'], ['recommended', 'Balanced'], ['extreme', 'Strong']], default: 'recommended',
      help: 'Strong gives the smallest file with visibly softer images.' }],
    report: (rs) => rs.map((r) => `${sizeLabel(r.before)} → ${sizeLabel(r.blob.size)} (${r.blob.size < r.before ? '−' + Math.round(100 - (r.blob.size / r.before) * 100) : '+' + Math.round((r.blob.size / r.before) * 100 - 100)}%)`).join(' · '),
  }),
  perFile({
    id: 'repair', cat: 'optimize', icon: '⚕', name: 'Repair PDF', action: 'Repair', outSuffix: '_repaired',
    desc: 'Rebuild a damaged PDF’s structure so it opens again, recovering what can be recovered.',
    async convert(f) {
      const bytes = await bytesOf(f);
      try { return await qpdf(bytes, ['$in', '$out']); } catch { return gs(bytes, []); } // qpdf first; Ghostscript re-draws what qpdf can't fix
    },
  }),
  perFile({
    id: 'ocr', cat: 'optimize', icon: '⌕', name: 'OCR PDF', action: 'Recognise text', outSuffix: '_ocr',
    desc: 'Turn scanned pages into searchable, selectable text. Pages that already have text are left alone.',
    options: () => [
      { key: 'lang', label: 'Document language', type: 'select', choices: OCR_LANGS, default: 'eng' },
      { key: 'lang2', label: 'Second language (optional)', type: 'select', choices: [['', 'None'], ...OCR_LANGS], default: '' },
    ],
    async convert(f, o, ctx) {
      const { bytes, done } = await ocrPdf(f, [...new Set([o.lang, o.lang2].filter(Boolean))], ctx.progress);
      if (!done) throw new UserError('Every page already has text, so there was nothing to recognise.');
      return bytes;
    },
  }),

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
  printTool({ id: 'word-to-pdf', cat: 'to', icon: 'W', name: 'Word to PDF', action: 'Convert', accept: '.docx', make: docxHtml,
    desc: 'Turn a Word document (.docx) into a PDF: text, headings, lists, tables and pictures. Complex layouts are simplified.' }),
  printTool({ id: 'powerpoint-to-pdf', cat: 'to', icon: 'P', name: 'PowerPoint to PDF', action: 'Convert', accept: '.pptx', make: pptxHtml,
    desc: 'Turn a presentation (.pptx) into a PDF, one page per slide: text boxes and pictures where they sit. Themes and effects are simplified.' }),
  printTool({ id: 'excel-to-pdf', cat: 'to', icon: 'X', name: 'Excel to PDF', action: 'Convert', accept: '.xlsx,.csv', make: sheetHtml,
    desc: 'Turn a spreadsheet (.xlsx or .csv) into a PDF, one table per sheet. Cell formatting and charts are not kept.' }),
  printTool({ id: 'html-to-pdf', cat: 'to', icon: '⟨⟩', name: 'HTML to PDF', action: 'Convert', accept: '.html,.htm', make: htmlFile,
    desc: 'Save an HTML file as a PDF. Scripts don’t run and nothing outside the file is loaded.' }),

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
  perFile({ id: 'pdf-to-word', cat: 'from', icon: 'W', name: 'PDF to Word', action: 'Convert', ext: 'docx', convert: (f, o, ctx) => pdfToDocx(f, ctx.progress),
    desc: 'Turn a PDF into an editable Word document: paragraphs and headings. Layout, images and tables are simplified. Scans need OCR first.' }),
  perFile({ id: 'pdf-to-powerpoint', cat: 'from', icon: 'P', name: 'PDF to PowerPoint', action: 'Convert', ext: 'pptx', convert: (f, o, ctx) => pdfToPptx(f, ctx.progress),
    desc: 'Make a slide deck with one slide per PDF page (pages become slide images).' }),
  perFile({ id: 'pdf-to-excel', cat: 'from', icon: 'X', name: 'PDF to Excel', action: 'Convert', ext: 'xlsx', convert: (f, o, ctx) => pdfToXlsx(f, ctx.progress),
    desc: 'Put the text of each page into a spreadsheet, lined up in rows and columns. Works best on clear tables.' }),
  perFile({ id: 'pdf-to-pdfa', cat: 'from', icon: 'A', name: 'PDF to PDF/A', action: 'Convert', outSuffix: '_pdfa',
    desc: 'Convert to PDF/A, the archive format meant to open the same way decades from now.',
    options: () => [{ key: 'level', label: 'Conformance', type: 'seg', choices: [['1', 'PDF/A-1b'], ['2', 'PDF/A-2b'], ['3', 'PDF/A-3b']], default: '2' }],
    convert: async (f, o) => pdfa(await bytesOf(f), o.level) }),

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
