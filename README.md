# pdfHero

Your own PDF toolbox: 31 tools (merge, split, compress, OCR, convert to/from Word, Excel and PowerPoint, sign, redact, edit text, and more), running **entirely in your browser**.

- It's a static site. There is no server that receives your files: every tool runs inside the browser tab, using WebAssembly builds of Ghostscript, qpdf and Tesseract plus pdf.js and pdf-lib.
- The page's Content-Security-Policy stops it from contacting any other site, so a file can't be sent anywhere even by mistake.
- Nothing is stored. Close the tab and your files are gone.

## Use it

Live at https://sentientarchon.github.io/pdfHero/ (GitHub Pages, served from the `gh-pages` branch).

To publish changes:

```bash
npm run deploy   # builds the site and pushes it to gh-pages
```

To run it locally:

```bash
npm install
npm start       # then open http://127.0.0.1:4321
```

## Test

```bash
npm start &
npm test        # 50 end-to-end checks in headless Chrome
```

The tests use the `qpdf` and `gs` command-line tools to inspect output files (`brew install qpdf ghostscript`). The app itself doesn't need them.

## Trade-offs of running in the browser

- **Word, Excel, PowerPoint and HTML to PDF** are rebuilt as a preview and saved with the browser's own "Save as PDF". Text, headings, tables and pictures come through; complex layouts, themes and charts are simplified. Only `.docx`, `.xlsx`/`.csv` and `.pptx` are supported (not the old `.doc`/`.xls`/`.ppt`).
- **PDF to Word/Excel** rebuild text and tables from the page; complex layouts are simplified.
- **OCR** languages included: English, Spanish, French, German, Portuguese, Italian.
- **Redact** rebuilds the whole file with Ghostscript, so links in the redacted copy are no longer clickable.
- **Edit PDF** can use fonts installed on your device in Chrome and Edge (it asks permission once); other browsers fall back to the PDF's own font or a standard one.

## Not included

AI Summarizer and Translate, because they would need a cloud AI service and your files would leave your device.

## Third-party engines

Ghostscript (`@jspawn/ghostscript-wasm`) is AGPL-3.0; its source is at https://github.com/jsscheller/ghostscript-wasm and https://ghostscript.com. qpdf is Apache-2.0, Tesseract.js Apache-2.0, pdf.js Apache-2.0, pdf-lib MIT, mammoth BSD-2-Clause, PptxGenJS MIT.
