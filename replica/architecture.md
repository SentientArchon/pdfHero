# Architecture

Privacy is the requirement, so: **no network**. The server binds to 127.0.0.1 only, the page
ships a Content-Security-Policy of `default-src 'self'` (the browser refuses to send anything
anywhere else), and there are no analytics, fonts or CDNs.

| layer | choice | why |
| --- | --- | --- |
| UI | vanilla JS ES modules, hash routing, no build step | nothing to compile, nothing to break |
| in-browser PDF | pdf-lib (write), pdf.js (render/text), JSZip (multi-file downloads) | file never leaves the tab |
| local server | Node `node:http`, no framework | serves the UI + 10 endpoints needing native tools |
| native tools | qpdf, Ghostscript, OCRmyPDF/Tesseract, LibreOffice, Chrome headless, Python (pdf2docx, pdfplumber, openpyxl, python-pptx) | best free engines for each job |
| storage | none; per-request temp dir, removed in `finally` | nothing to leak |

## Where each tool runs
- Browser: merge, split, remove, extract, organize, scan, rotate, page numbers, watermark, crop,
  edit, forms, sign, redact, compare, JPG→PDF, PDF→JPG, PDF→Markdown.
- Server (`POST /api/<op>`, raw file body, options in query string): compress, repair, ocr,
  pdfa, protect, unlock, office→pdf (word/ppt/excel), pdf→word, pdf→excel, pdf→ppt, html→pdf.
- `GET /api/health` reports which native tools exist, so S02 can show "unavailable" instead of failing.

## Parts that bite
- File size: server body limit 500 MB; browser holds files in memory.
- Redaction must remove content, not cover it: redacted pages are rasterised with the boxes
  burnt in.
- Standard PDF fonts only cover Latin-1; text tools note that.
- Protect/unlock passwords travel only over loopback in a header, never logged.

## Build order
1. Shell + server + merge (vertical slice). 2. All browser tools. 3. Server tools. 4. Test.
