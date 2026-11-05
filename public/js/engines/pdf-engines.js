// In-browser replacements for the old local helper: Ghostscript, qpdf, Tesseract and file-format writers.
import { runWasm, NATIVE, UserError, VENDOR, PDFLib, loadPdfLib, loadPdfJs, renderPage, canvasBlob, h } from '../lib.js';
import { pageLines } from '../tools/convert.js';

const tail = (log) => log.filter(Boolean).slice(-3).join(' ').slice(0, 300);

/** Ghostscript pdfwrite: input bytes -> output PDF bytes. */
export async function gs(bytes, args, extraFiles = {}) {
  const r = await runWasm('gs', ['-sDEVICE=pdfwrite', '-dNOPAUSE', '-dBATCH', '-dQUIET', '-dSAFER', ...args, '-sOutputFile=/out.pdf', '/in.pdf'],
    { '/in.pdf': bytes, ...extraFiles }, ['/out.pdf']);
  const out = r.out['/out.pdf'];
  if (r.code !== 0 || !out?.length) throw new UserError(`Ghostscript couldn’t process this file. ${tail(r.log)}`);
  return out;
}

/** qpdf: exit 0 = ok, 3 = ok with warnings. Returns output bytes. */
export async function qpdf(bytes, args) {
  const r = await runWasm('qpdf', [...args.map((a) => (a === '$in' ? '/in.pdf' : a === '$out' ? '/out.pdf' : a))], { '/in.pdf': bytes }, ['/out.pdf']);
  const out = r.out['/out.pdf'];
  if ((r.code === 0 || r.code === 3) && out?.length) return out;
  const msg = r.log.join(' ');
  // this qpdf build doesn't pass its error text through; exit 2 on an encrypted file means the password was wrong
  const encrypted = new TextDecoder('latin1').decode(bytes).includes('/Encrypt');
  if (/invalid password/i.test(msg) || (args.includes('--decrypt') && r.code === 2 && encrypted)) throw new UserError('Wrong password for this file.');
  throw new UserError(`qpdf couldn’t process this file. ${tail(r.log)}`);
}

export const COMPRESS = { low: '/printer', recommended: '/ebook', extreme: '/screen' };

// PDF/A needs an output intent with an ICC profile; Ghostscript ships sRGB in its built-in resources.
const PDFA_DEF = `%!
[/_objdef {icc_PDFA} /type /stream /OBJ pdfmark
[{icc_PDFA} <</N 3>> /PUT pdfmark
[{icc_PDFA} (${(NATIVE?.has.gs && NATIVE.has.icc) || '%rom%iccprofiles/srgb.icc'}) (r) file /PUT pdfmark
[/_objdef {OutputIntent_PDFA} /type /dict /OBJ pdfmark
[{OutputIntent_PDFA} <</Type /OutputIntent /S /GTS_PDFA1 /DestOutputProfile {icc_PDFA} /OutputConditionIdentifier (sRGB)>> /PUT pdfmark
[{Catalog} <</OutputIntents [ {OutputIntent_PDFA} ]>> /PUT pdfmark
`;
export async function pdfa(bytes, level) {
  // the pdfmark file must come before the input on the command line
  const r = await runWasm('gs', ['-sDEVICE=pdfwrite', '-dNOPAUSE', '-dBATCH', '-dQUIET', `-dPDFA=${level}`, '-dPDFACompatibilityPolicy=1',
    '-sColorConversionStrategy=RGB', '-sProcessColorModel=DeviceRGB', '-sOutputFile=/out.pdf', '/def.ps', '/in.pdf'],
  { '/in.pdf': bytes, '/def.ps': new TextEncoder().encode(PDFA_DEF) }, ['/out.pdf']);
  if (r.code !== 0 || !r.out['/out.pdf']?.length) throw new UserError(`Couldn’t convert to PDF/A. ${tail(r.log)}`);
  return r.out['/out.pdf'];
}

// ---------- OCR ----------
let tess;
async function tesseract() {
  if (!window.Tesseract) {
    await new Promise((ok, fail) => { const s = h('script', { src: `${VENDOR}tesseract/tesseract.min.js` }); s.onload = ok; s.onerror = () => fail(new Error('OCR engine failed to load.')); document.head.append(s); });
  }
  return window.Tesseract;
}
export const OCR_LANGS = [['eng', 'English'], ['spa', 'Spanish'], ['fra', 'French'], ['deu', 'German'], ['por', 'Portuguese'], ['ita', 'Italian']];

/**
 * Searchable PDF: pages that already have text are kept as they are; scanned pages get an invisible
 * text layer (one run per recognised word, stretched to the word's width), like OCRmyPDF does.
 */
export async function ocrPdf(file, langs, progress) {
  const T = await tesseract();
  tess ||= {};
  const key = langs.join('+');
  const worker = tess[key] ||= await T.createWorker(langs, 1, {
    workerPath: `${VENDOR}tesseract/worker.min.js`, corePath: `${VENDOR}tesseract/core`, langPath: `${VENDOR}tessdata`,
    workerBlobURL: false, gzip: true, cacheMethod: 'none',
  });
  const js = await loadPdfJs(file);
  const doc = await loadPdfLib(file);
  const font = await doc.embedFont(PDFLib.StandardFonts.Helvetica);
  const { pushGraphicsState, popGraphicsState, beginText, endText, setFontAndSize, setTextRenderingMode, TextRenderingMode, setTextMatrix, showText, setCharacterSqueeze } = PDFLib;
  let done = 0;
  for (let n = 1; n <= js.numPages; n++) {
    const page = await js.getPage(n);
    if ((await page.getTextContent()).items.some((i) => i.str.trim())) continue; // already has text
    progress(`Reading page ${n} of ${js.numPages}…`);
    const scale = 300 / 72;
    const canvas = await renderPage(page, scale);
    const { data } = await worker.recognize(canvas, {}, { blocks: true });
    canvas.width = 0;
    const pdfPage = doc.getPage(n - 1);
    const vp = page.getViewport({ scale });
    const ops = [pushGraphicsState(), beginText(), setTextRenderingMode(TextRenderingMode.Invisible)];
    pdfPage.node.setFontDictionary(PDFLib.PDFName.of('FOcr'), font.ref);
    for (const block of data.blocks || []) for (const par of block.paragraphs) for (const line of par.lines) for (const w of line.words) {
      const text = [...w.text].map((ch) => { try { font.encodeText(ch); return ch; } catch { return '?'; } }).join('');
      if (!text.trim()) continue;
      const { x0, y0, x1, y1 } = w.bbox;
      const [px, py] = vp.convertToPdfPoint(x0, y1); // bottom-left of the word
      const [qx, qy] = vp.convertToPdfPoint(x1, y0);
      const size = Math.max(1, Math.abs(qy - py));
      const natural = font.widthOfTextAtSize(text, size);
      ops.push(setFontAndSize('FOcr', size), setCharacterSqueeze(natural ? (Math.abs(qx - px) / natural) * 100 : 100),
        setTextMatrix(1, 0, 0, 1, Math.min(px, qx), Math.min(py, qy)), showText(font.encodeText(text)));
    }
    ops.push(endText(), popGraphicsState());
    pdfPage.pushOperators(...ops);
    done++;
  }
  return { bytes: await doc.save(), done };
}

// ---------- PDF -> Office ----------
const xmlEsc = (s) => s.replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c])).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');

/** Lines of every page, with size and boldness, from pdf.js text. */
async function allLines(file, progress) {
  const js = await loadPdfJs(file);
  const pages = [];
  for (let n = 1; n <= js.numPages; n++) { progress(`Reading page ${n} of ${js.numPages}…`); pages.push(await pageLines(await js.getPage(n))); }
  return pages;
}

/** Word document: paragraphs rebuilt from line spacing, headings from font size, a page break per page. */
export async function pdfToDocx(file, progress) {
  const pages = await allLines(file, progress);
  if (!pages.flat().length) throw new UserError('No text found. If this is a scan, run OCR PDF first.');
  const chars = {};
  for (const l of pages.flat()) chars[l.size] = (chars[l.size] || 0) + l.text.length;
  const body = +Object.entries(chars).sort((a, b) => b[1] - a[1])[0][0];
  const para = (text, size) => {
    const heading = size >= body * 1.15;
    return `<w:p>${heading ? `<w:pPr><w:pStyle w:val="Heading${size >= body * 1.8 ? 1 : size >= body * 1.4 ? 2 : 3}"/></w:pPr>` : ''}<w:r><w:rPr><w:sz w:val="${Math.round(size * 2)}"/></w:rPr><w:t xml:space="preserve">${xmlEsc(text)}</w:t></w:r></w:p>`;
  };
  let xml = '';
  pages.forEach((lines, pi) => {
    let buf = []; let size = body;
    const flush = () => { if (buf.length) xml += para(buf.join(' ').replace(/-\s(?=[a-z])/g, ''), size); buf = []; };
    lines.forEach((l, k) => {
      const gap = k ? lines[k - 1].y - l.y : 0;
      if (Math.abs(l.size - size) > 0.5 || gap > l.size * 1.8) flush();
      size = l.size; buf.push(l.text);
    });
    flush();
    if (pi < pages.length - 1) xml += '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';
  });
  const z = new window.JSZip();
  z.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>');
  z.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  z.file('word/_rels/document.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>');
  z.file('word/styles.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">${[1, 2, 3].map((i) => `<w:style w:type="paragraph" w:styleId="Heading${i}"><w:name w:val="heading ${i}"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:outlineLvl w:val="${i - 1}"/></w:pPr><w:rPr><w:b/></w:rPr></w:style>`).join('')}</w:styles>`);
  z.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${xml}</w:body></w:document>`);
  return z.generateAsync({ type: 'blob', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
}

/** Spreadsheet: per page, text items grouped into rows by baseline and into columns by x position. */
export async function pdfToXlsx(file, progress) {
  const js = await loadPdfJs(file);
  const sheets = [];
  for (let n = 1; n <= js.numPages; n++) {
    progress(`Reading page ${n} of ${js.numPages}…`);
    const items = (await (await js.getPage(n)).getTextContent()).items.filter((i) => i.str.trim())
      .map((i) => ({ x: i.transform[4], y: i.transform[5], w: i.width, s: i.str.trim(), size: Math.hypot(i.transform[2], i.transform[3]) }));
    if (!items.length) continue;
    // rows: same baseline
    items.sort((a, b) => b.y - a.y || a.x - b.x);
    const rows = [];
    for (const it of items) {
      const row = rows.find((r) => Math.abs(r.y - it.y) <= it.size * 0.4);
      row ? row.cells.push(it) : rows.push({ y: it.y, cells: [it] });
    }
    // columns: cluster cell start positions across the page
    const starts = items.map((i) => i.x).sort((a, b) => a - b);
    const cols = [];
    for (const x of starts) if (!cols.length || x - cols[cols.length - 1] > 12) cols.push(x);
    const colOf = (x) => { let best = 0; cols.forEach((c, i) => { if (Math.abs(c - x) < Math.abs(cols[best] - x)) best = i; }); return best; };
    const grid = rows.map((r) => {
      const out = [];
      for (const c of r.cells.sort((a, b) => a.x - b.x)) { const k = colOf(c.x); out[k] = out[k] ? `${out[k]} ${c.s}` : c.s; }
      return out;
    });
    sheets.push({ name: `Page ${n}`, grid });
  }
  if (!sheets.length) throw new UserError('No text found. If this is a scan, run OCR PDF first.');
  return writeXlsx(sheets);
}

function writeXlsx(sheets) {
  const col = (i) => { let s = ''; for (i++; i; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s; return s; };
  const cell = (v, ref) => {
    if (v == null || v === '') return '';
    const num = /^-?[\d,]*\.?\d+$/.test(v) ? Number(v.replace(/,/g, '')) : NaN;
    return Number.isFinite(num) ? `<c r="${ref}"><v>${num}</v></c>` : `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlEsc(v)}</t></is></c>`;
  };
  const z = new window.JSZip();
  z.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`);
  z.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>');
  z.file('xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((s, i) => `<sheet name="${xmlEsc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`);
  z.file('xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}</Relationships>`);
  sheets.forEach((s, i) => z.file(`xl/worksheets/sheet${i + 1}.xml`, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${s.grid.map((row, r) => `<row r="${r + 1}">${[...row].map((v, c) => cell(v, `${col(c)}${r + 1}`)).join('')}</row>`).join('')}</sheetData></worksheet>`));
  return z.generateAsync({ type: 'blob', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}

/** Slide deck: one slide per page, the page as an image (same as before). */
export async function pdfToPptx(file, progress) {
  if (!window.PptxGenJS) {
    await new Promise((ok, fail) => { const s = h('script', { src: `${VENDOR}pptxgen.js` }); s.onload = ok; s.onerror = () => fail(new Error('Slide writer failed to load.')); document.head.append(s); });
  }
  const js = await loadPdfJs(file);
  const first = (await js.getPage(1)).getViewport({ scale: 1 });
  const pptx = new window.PptxGenJS();
  pptx.defineLayout({ name: 'PDF', width: first.width / 72, height: first.height / 72 });
  pptx.layout = 'PDF';
  for (let n = 1; n <= js.numPages; n++) {
    progress(`Page ${n} of ${js.numPages}…`);
    const c = await renderPage(await js.getPage(n), 150 / 72);
    const blob = await canvasBlob(c, 'image/png');
    const data = await new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(blob); });
    c.width = 0;
    pptx.addSlide().addImage({ data, x: 0, y: 0, w: first.width / 72, h: first.height / 72 });
  }
  return pptx.write({ outputType: 'blob' });
}

