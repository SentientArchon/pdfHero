// Builds sample inputs for the e2e test.
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import fs from 'node:fs';
const dir = new URL('./fixtures/', import.meta.url).pathname;
async function doc(n, label) {
  const d = await PDFDocument.create(); const f = await d.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= n; i++) {
    const p = d.addPage([595, 842]);
    p.drawText(`${label} heading ${i}`, { x: 50, y: 760, size: 28, font: f });
    p.drawText(`Secret code 1234 on page ${i}. Ordinary body text here.`, { x: 50, y: 700, size: 12, font: f });
    p.drawRectangle({ x: 50, y: 400, width: 200, height: 150, color: rgb(0.2, 0.4, 0.8) });
  }
  return d;
}
fs.writeFileSync(dir + 'a.pdf', await (await doc(5, 'Alpha')).save());
fs.writeFileSync(dir + 'b.pdf', await (await doc(3, 'Beta')).save());
const form = await doc(1, 'Form'); const fm = form.getForm();
fm.createTextField('full_name').addToPage(form.getPage(0), { x: 50, y: 300, width: 200, height: 24 });
fm.createCheckBox('agree').addToPage(form.getPage(0), { x: 50, y: 260, width: 16, height: 16 });
fs.writeFileSync(dir + 'form.pdf', await form.save());
fs.writeFileSync(dir + 'page.html', '<!doctype html><h1>Hello from HTML</h1><p>Converted locally.</p>');
// 2x2 red PNG
fs.writeFileSync(dir + 'img.png', Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==', 'base64'));
console.log('fixtures ok');
