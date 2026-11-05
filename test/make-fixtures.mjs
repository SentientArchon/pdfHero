// Builds sample inputs for the e2e test.
import { PDFDocument, StandardFonts, rgb, PDFName, PDFHexString, PDFString } from 'pdf-lib';
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
// A title with a drawn underline (as Word makes them): a thin rectangle just below the baseline.
const ul = await PDFDocument.create(); const tb = await ul.embedFont(StandardFonts.TimesRomanBold);
const ulp = ul.addPage([595, 842]); ulp.drawText('Underlined title', { x: 50, y: 760, size: 18, font: tb });
ulp.drawRectangle({ x: 50, y: 757, width: tb.widthOfTextAtSize('Underlined title', 18), height: 1.2, color: rgb(0, 0, 0) });
fs.writeFileSync(dir + 'underline.pdf', await ul.save());
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
{
  const d = await PDFDocument.create(); const f = await d.embedFont(StandardFonts.Helvetica);
  const p1 = d.addPage([595, 842]); p1.drawText('Linked one private', { x: 50, y: 760, size: 20, font: f });
  const p2 = d.addPage([595, 842]); p2.drawText('Linked two public', { x: 50, y: 760, size: 20, font: f });
  const link = d.context.register(d.context.obj({ Type: 'Annot', Subtype: 'Link', Rect: [50, 700, 200, 720], Dest: [p1.ref, 'Fit'], P: p2.ref }));
  const note = d.context.register(d.context.obj({ Type: 'Annot', Subtype: 'Text', Rect: [50, 650, 70, 670], Contents: PDFHexString.fromText('note'), P: p1.ref }));
  const web = d.context.register(d.context.obj({ Type: 'Annot', Subtype: 'Link', Rect: [50, 600, 200, 620], A: { S: 'URI', URI: PDFString.of('https://example.com') } }));
  const sneaky = d.context.register(d.context.obj({ Type: 'Annot', Subtype: 'Link', Rect: [50, 550, 200, 570], A: { S: 'URI', URI: p1.node.get(PDFName.of('Contents')) }, Foo: p1.ref }));
  p2.node.set(PDFName.of('Annots'), d.context.obj([link, note, web, sneaky]));
  p2.node.set(PDFName.of('Thumb'), p1.ref); // unknown/unsafe page keys must not survive either
  p2.node.set(PDFName.of('Group'), d.context.obj({ S: 'Transparency', CS: 'DeviceRGB', Leak: p1.node.get(PDFName.of('Contents')) }));
  const apStream = d.context.register(d.context.stream('0 0 1 rg 0 0 10 10 re f', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 10, 10], Foo: p1.node.get(PDFName.of('Contents')) }));
  const stamp = d.context.register(d.context.obj({ Type: 'Annot', Subtype: 'Stamp', Rect: [300, 300, 310, 310], AP: { N: apStream, X: p1.node.get(PDFName.of('Contents')) } }));
  d.context.lookup(p2.node.get(PDFName.of('Annots'))).push(stamp);
  fs.writeFileSync(dir + 'linked.pdf', await d.save());
}
// Text in an embedded *subset* of a real font, as most PDFs have it.
{
  const georgia = '/System/Library/Fonts/Supplemental/Georgia.ttf';
  if (fs.existsSync(georgia)) {
    const fontkit = (await import('@pdf-lib/fontkit')).default;
    const d = await PDFDocument.create(); d.registerFontkit(fontkit);
    const f = await d.embedFont(fs.readFileSync(georgia), { subset: true });
    d.addPage([595, 842]).drawText('Georgia sample line', { x: 50, y: 760, size: 18, font: f });
    fs.writeFileSync(dir + 'georgia.pdf', await d.save());
  }
}
fs.writeFileSync(dir + 'page.html', '<!doctype html><h1>Hello from HTML</h1><p>Converted locally.</p>');
// 2x2 red PNG
fs.writeFileSync(dir + 'img.png', Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==', 'base64'));
console.log('fixtures ok');
