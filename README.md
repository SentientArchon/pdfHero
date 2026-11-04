# pdfHero

Your own PDF toolbox: 31 tools (merge, split, compress, OCR, convert to/from Word, Excel, PowerPoint, sign, redact, and more) running **only on this computer**.

- The server listens on `127.0.0.1` only, so nothing else on your network can reach it.
- The page's Content-Security-Policy blocks it from contacting any other server.
- Files are handled in the browser tab or in a temp folder that is deleted as soon as each job finishes. No accounts, history or tracking.

## Run

```bash
npm install
npm run setup   # once: qpdf, Ghostscript, OCRmyPDF/Tesseract, LibreOffice, Python converters
npm start       # then open http://127.0.0.1:4321
```

Tools that need a converter you haven't installed show the install command on their page.

## Test

```bash
npm start &
npm test        # 49 end-to-end checks in headless Chrome
```

## Not included

AI Summarizer and Translate, because they would need a cloud AI service and your files would leave the machine.
