// Copies the browser engines from node_modules into public/vendor (run by `npm run build`).
import fs from 'node:fs';
import path from 'node:path';
const root = path.dirname(new URL(import.meta.url).pathname) + '/..';
const nm = (p) => path.join(root, 'node_modules', p);
const out = path.join(root, 'public/vendor');
fs.rmSync(out, { recursive: true, force: true });
const copy = (from, to) => { fs.mkdirSync(path.dirname(path.join(out, to)), { recursive: true }); fs.cpSync(nm(from), path.join(out, to), { recursive: true }); };

for (const d of ['build/pdf.min.mjs', 'build/pdf.worker.min.mjs', 'cmaps', 'standard_fonts', 'wasm', 'iccs']) copy(`pdfjs-dist/${d}`, `pdfjs/${d}`);
copy('pdf-lib/dist/pdf-lib.esm.min.js', 'pdf-lib.js');
copy('jszip/dist/jszip.min.js', 'jszip.js');
copy('@pdf-lib/fontkit/dist/fontkit.umd.min.js', 'fontkit.js');
copy('@jspawn/ghostscript-wasm/gs.js', 'gs/gs.js');
copy('@jspawn/ghostscript-wasm/gs.wasm', 'gs/gs.wasm');
copy('@neslinesli93/qpdf-wasm/dist/qpdf.js', 'qpdf/qpdf.js');
copy('@neslinesli93/qpdf-wasm/dist/qpdf.wasm', 'qpdf/qpdf.wasm');
copy('tesseract.js/dist/tesseract.min.js', 'tesseract/tesseract.min.js');
copy('tesseract.js/dist/worker.min.js', 'tesseract/worker.min.js');
for (const f of fs.readdirSync(nm('tesseract.js-core'))) if (/^tesseract-core.*\.(js|wasm)$/.test(f)) copy(`tesseract.js-core/${f}`, `tesseract/core/${f}`);
copy('mammoth/mammoth.browser.min.js', 'mammoth.js');
copy('pptxgenjs/dist/pptxgen.bundle.js', 'pptxgen.js');

// OCR language data: committed in vendor-src/tessdata (gzipped), copied as-is
const tess = path.join(root, 'vendor-src/tessdata');
fs.mkdirSync(path.join(out, 'tessdata'), { recursive: true });
for (const f of fs.readdirSync(tess)) fs.copyFileSync(path.join(tess, f), path.join(out, 'tessdata', f));

let total = 0; let biggest = ['', 0];
(function walk(d) { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); const s = fs.statSync(p); if (s.isDirectory()) walk(p); else { total += s.size; if (s.size > biggest[1]) biggest = [p, s.size]; } } })(out);
console.log(`vendor: ${(total / 1048576).toFixed(1)} MB, largest ${path.relative(out, biggest[0])} ${(biggest[1] / 1048576).toFixed(1)} MB`);
