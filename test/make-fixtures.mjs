// Builds sample inputs for the e2e test.
import { PDFDocument, StandardFonts, rgb, PDFName } from 'pdf-lib';
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
// Two pages sharing one Resources dict; the 2x2 image is only drawn on page 1.
const shared = await PDFDocument.create(); const sf = await shared.embedFont(StandardFonts.Helvetica);
const png = await shared.embedPng(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==', 'base64'));
const s1 = shared.addPage([595, 842]); s1.drawText('Page one private', { x: 50, y: 760, size: 20, font: sf }); s1.drawImage(png, { x: 50, y: 500, width: 200, height: 200 });
const s2 = shared.addPage([595, 842]); s2.drawText('Page two public', { x: 50, y: 760, size: 20, font: sf });
const resRef = shared.context.register(s1.node.Resources());
s1.node.set(PDFName.of('Resources'), resRef); s2.node.set(PDFName.of('Resources'), resRef);
fs.writeFileSync(dir + 'shared.pdf', await shared.save());
// Nested: a Form XObject (drawn on both pages) whose shared Resources also hold an image only page 1's own content uses.
{
  const d = await PDFDocument.create(); const f = await d.embedFont(StandardFonts.Helvetica);
  const img = await d.embedPng(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAMAAAADCAIAAADZSiLoAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAAhIwEFAxQZqQAAAABJRU5ErkJggg==', 'base64'));
  const p1 = d.addPage([595, 842]); p1.drawText('Nested one private', { x: 50, y: 760, size: 20, font: f }); p1.drawImage(img, { x: 50, y: 500, width: 100, height: 100 });
  const p2 = d.addPage([595, 842]); p2.drawText('Nested two public', { x: 50, y: 760, size: 20, font: f });
  const imgKey = p1.node.Resources().lookup(PDFName.of('XObject')).keys()[0];
  const formRes = d.context.obj({ XObject: { [imgKey.asString().slice(1)]: img.ref } }); // form's own resources include the image
  const form = d.context.stream('0 0 1 rg 0 0 10 10 re f', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 10, 10], Resources: formRes });
  const formRef = d.context.register(form);
  for (const p of [p1, p2]) {
    p.node.Resources().lookup(PDFName.of('XObject')).set(PDFName.of('Fm1'), formRef);
    const cs = d.context.register(d.context.stream('q 1 0 0 1 300 300 cm /Fm1 Do Q'));
    p.node.addContentStream(cs);
  }
  p2.node.Resources().lookup(PDFName.of('XObject')).delete(imgKey);
  fs.writeFileSync(dir + 'nested.pdf', await d.save());
}
{
  const d = await PDFDocument.create(); const f = await d.embedFont(StandardFonts.Helvetica);
  const img = await d.embedPng(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAMAAAADCAIAAADZSiLoAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAAhIwEFAxQZqQAAAABJRU5ErkJggg==', 'base64'));
  const p1 = d.addPage([595, 842]); p1.drawText('Masked one private', { x: 50, y: 760, size: 20, font: f }); p1.drawImage(img, { x: 50, y: 500, width: 100, height: 100 });
  const p2 = d.addPage([595, 842]); p2.drawText('Masked two public', { x: 50, y: 760, size: 20, font: f });
  const group = d.context.register(d.context.stream('1 g 0 0 10 10 re f', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 10, 10], Group: { S: 'Transparency', CS: 'DeviceGray' }, Resources: d.context.obj({ XObject: { ImLeak: img.ref } }) }));
  const gs = d.context.register(d.context.obj({ Type: 'ExtGState', SMask: { Type: 'Mask', S: 'Luminosity', G: group } }));
  const res = p2.node.Resources();
  res.set(PDFName.of('ExtGState'), d.context.obj({ GSm: gs }));
  p2.node.addContentStream(d.context.register(d.context.stream('q /GSm gs 0 0 1 rg 300 300 50 50 re f Q')));
  fs.writeFileSync(dir + 'smask.pdf', await d.save());
}
fs.writeFileSync(dir + 'page.html', '<!doctype html><h1>Hello from HTML</h1><p>Converted locally.</p>');
// 2x2 red PNG
fs.writeFileSync(dir + 'img.png', Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==', 'base64'));
console.log('fixtures ok');
