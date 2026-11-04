// End-to-end: drives every tool in headless Chrome against the running server.
// Run: npm start (in another terminal), then npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright-core';
import { PDFDocument } from 'pdf-lib';

const BASE = process.env.BASE || 'http://127.0.0.1:4321/';
const FIX = new URL('./fixtures/', import.meta.url).pathname;
let browser; let page; const errors = [];

before(async () => {
  execFileSync('node', [new URL('./make-fixtures.mjs', import.meta.url).pathname]);
  browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  page = await (await browser.newContext({ acceptDownloads: true, viewport: { width: 1440, height: 1000 } })).newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('request', (r) => { if (!r.url().startsWith(BASE.slice(0, -1)) && !/^(blob|data):/.test(r.url())) errors.push(`outside request: ${r.url()}`); });
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
});
after(async () => { await browser?.close(); });

async function open(id, files = []) {
  await page.goto(`${BASE}#/`); // force a fresh hashchange even when the tool is the same
  await page.goto(`${BASE}#/${id}`);
  await page.waitForSelector('h1');
  if (files.length) await page.setInputFiles('#file-in', files.map((f) => FIX + f));
  await page.waitForSelector('.panel > button.btn.primary');
}
async function run() {
  await page.click('.panel > button.btn.primary');
  await page.waitForSelector('.result .done, .result .alert.err', { timeout: 180e3 });
  const err = await page.$('.result .alert.err');
  if (err) throw new Error(await err.textContent());
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('.result .done button.btn.primary')]);
  return { buf: fs.readFileSync(await dl.path()), name: dl.suggestedFilename() };
}
const pdf = (buf) => PDFDocument.load(buf);
function rawPdf(buf) {
  const f = path.join(os.tmpdir(), `pdfhero-raw-${Math.random()}.pdf`); fs.writeFileSync(f, buf);
  try { return execFileSync('qpdf', ['--qdf', '--object-streams=disable', '--decode-level=all', f, '-'], { maxBuffer: 1 << 28 }).toString('latin1'); } finally { fs.rmSync(f); }
}
const isZip = (buf) => buf[0] === 0x50 && buf[1] === 0x4b;
function text(buf) {
  const f = path.join(os.tmpdir(), `pdfhero-test-${Math.random()}.pdf`);
  fs.writeFileSync(f, buf);
  try { return execFileSync('gs', ['-q', '-sDEVICE=txtwrite', '-o', '-', f]).toString(); } finally { fs.rmSync(f); }
}
async function dragOnStage(x0, y0, x1, y1) {
  await page.locator('.stage').scrollIntoViewIfNeeded();
  const b = await page.locator('.stage-overlay').boundingBox();
  await page.mouse.move(b.x + x0, b.y + y0); await page.mouse.down();
  await page.mouse.move(b.x + (x0 + x1) / 2, b.y + (y0 + y1) / 2); await page.mouse.move(b.x + x1, b.y + y1); await page.mouse.up();
}
const clickStage = async (x, y) => { await page.locator('.stage').scrollIntoViewIfNeeded(); const b = await page.locator('.stage-overlay').boundingBox(); await page.mouse.click(b.x + x, b.y + y); };

test('home lists every tool and filters', async () => {
  await page.goto(BASE);
  assert.equal(await page.locator('.card').count(), 31);
  await page.fill('.search', 'zzzz');
  assert.match(await page.textContent('.grid'), /No tool matches/);
});

test('merge', async () => { await open('merge', ['a.pdf', 'b.pdf']); assert.equal((await pdf((await run()).buf)).getPageCount(), 8); });
test('merge rejects a single file', async () => { await open('merge', ['a.pdf']); await assert.rejects(run(), /at least two/); });
test('split by ranges', async () => { await open('split', ['a.pdf']); await page.fill('#opt-ranges', '1-2, 3-5'); assert.ok(isZip((await run()).buf)); });
test('split bad range errors', async () => { await open('split', ['a.pdf']); await page.fill('#opt-ranges', '9-12'); await assert.rejects(run(), /outside/); });
test('split every page', async () => { await open('split', ['a.pdf']); await page.click('.seg-btn:text("Every page")'); assert.ok(isZip((await run()).buf)); });
test('remove pages by clicking', async () => {
  await open('remove', ['a.pdf']); await page.waitForSelector('.pg-btn');
  await page.locator('.pg-btn').nth(0).click(); await page.locator('.pg-btn').nth(1).click();
  assert.equal((await pdf((await run()).buf)).getPageCount(), 3);
});
test('extract pages by typing', async () => { await open('extract', ['a.pdf']); await page.waitForSelector('.pg-btn'); await page.fill('#opt-ranges', '2-3'); assert.equal((await pdf((await run()).buf)).getPageCount(), 2); });
test('organize: delete, rotate, blank', async () => {
  await open('organize', ['a.pdf']); await page.waitForSelector('.pg');
  await page.click('[aria-label="Delete Page 1"]'); await page.click('[aria-label="Rotate Page 1"]'); await page.click('[aria-label="Insert blank page after Page 1"]');
  const d = await pdf((await run()).buf);
  assert.equal(d.getPageCount(), 5); assert.equal(d.getPage(0).getRotation().angle, 90);
});
test('scan to pdf from photos', async () => { await open('scan', ['img.png', 'img.png']); assert.equal((await pdf((await run()).buf)).getPageCount(), 2); });
test('jpg to pdf', async () => { await open('jpg-to-pdf', ['img.png']); await page.selectOption('#opt-size', 'a4'); const d = await pdf((await run()).buf); assert.equal(Math.round(d.getPage(0).getWidth()), 595); });
test('pdf to jpg', async () => { await open('pdf-to-jpg', ['a.pdf']); const r = await run(); assert.ok(isZip(r.buf)); });
test('rotate', async () => { await open('rotate', ['a.pdf']); const d = await pdf((await run()).buf); assert.equal(d.getPage(4).getRotation().angle, 90); });
test('page numbers', async () => { await open('page-numbers', ['a.pdf']); await page.selectOption('#opt-format', 'Page {n} of {total}'); assert.match(text((await run()).buf), /Page 3 of 5/); });
test('watermark text', async () => { await open('watermark', ['a.pdf']); assert.match(text((await run()).buf), /CONFIDENTIAL/); });
test('watermark under content', async () => { await open('watermark', ['a.pdf']); await page.check('#opt-under'); await page.selectOption('#opt-pos', 'tile'); assert.match(text((await run()).buf), /CONFIDENTIAL/); });
test('crop', async () => {
  await open('crop', ['a.pdf']); await page.waitForSelector('.stage canvas'); await dragOnStage(80, 120, 300, 340);
  const d = await pdf((await run()).buf); assert.ok(d.getPage(2).getCropBox().width < 595);
});
test('edit: add text', async () => {
  await open('edit-pdf', ['a.pdf']); await page.waitForSelector('.stage canvas');
  await page.click('.seg-btn:text("Add text")'); await clickStage(100, 400); await page.keyboard.type('Hello edit');
  await page.click('.seg-btn:text("Rectangle")'); await dragOnStage(300, 500, 400, 560);
  assert.match(text((await run()).buf), /Hello edit/);
});
test('edit: change existing text', async () => {
  await open('edit-pdf', ['a.pdf']); await page.waitForSelector('.text-hit');
  const hits = await page.locator('.text-hit').count();
  assert.ok(hits >= 2, `expected clickable text runs, got ${hits}`);
  await page.click('[aria-label="Edit text: Alpha heading 1"]');
  await page.keyboard.type('Changed title');
  assert.equal(await page.locator('.cover').count(), 1);
  const { buf } = await run();
  const t = text(buf);
  assert.match(t, /Changed title/);
  const d = await pdf(buf);
  assert.equal(d.getPageCount(), 5);
  // the replacement is drawn at the original's 28pt size: 5 original headings + 1 new
  assert.equal((rawPdf(buf).match(/ 28 Tf/g) || []).length, 6);
});
test('edit: removing an edit restores the original', async () => {
  await open('edit-pdf', ['a.pdf']); await page.waitForSelector('.text-hit');
  await page.click('[aria-label="Edit text: Alpha heading 1"]');
  await page.click('.item.selected .item-del');
  assert.equal(await page.locator('.cover').count(), 0);
  assert.ok(await page.locator('[aria-label="Edit text: Alpha heading 1"]').count());
});
test('forms: fill and flatten', async () => {
  await open('forms', ['form.pdf']); await page.waitForSelector('.form-fields');
  await page.fill('#ff-0', 'Ada Lovelace'); await page.check('#ff-1');
  const d = await pdf((await run()).buf); assert.equal(d.getForm().getTextField('full_name').getText(), 'Ada Lovelace');
});
test('forms without fields says so', async () => { await open('forms', ['a.pdf']); await page.waitForSelector('.files .alert'); });
test('sign: typed signature', async () => {
  await open('sign', ['a.pdf']); await page.waitForSelector('.stage canvas');
  await page.click('.seg-btn:text("Type")'); await page.fill('[aria-label="Your name"]', 'Ada L');
  await page.click('.seg-btn:text("Place signature")'); await clickStage(200, 150);
  await page.waitForSelector('.item-image');
  const r = await run(); assert.ok(r.buf.length > fs.statSync(FIX + 'a.pdf').size);
});
test('redact: find text removes it', async () => {
  await open('redact', ['a.pdf']); await page.waitForSelector('.stage canvas');
  await page.fill('[aria-label="Text to find and redact"]', 'Secret'); await page.click('text=Mark all matches');
  await page.waitForSelector('text=/5 match/');
  const { buf } = await run();
  assert.doesNotMatch(text(buf), /Secret/);
  // and not hiding in unreachable objects: decompress every stream and grep the raw bytes
  assert.doesNotMatch(rawPdf(buf), /Secret|536563726574/i); // pdf-lib writes text as hex strings
});
test('redact: image shared with an untouched page does not survive', async () => {
  assert.match(rawPdf(fs.readFileSync(FIX + 'shared.pdf')), /\/Width 2\b/); // the check can see it in the source
  await open('redact', ['shared.pdf']); await page.waitForSelector('.stage canvas');
  await page.fill('[aria-label="Text to find and redact"]', 'private'); await page.click('text=Mark all matches');
  await page.waitForSelector('text=/1 match/');
  const { buf } = await run();
  assert.doesNotMatch(rawPdf(buf), /\/Width 2\b/);
  assert.match(text(buf), /Page two public/);
});
test('redact: image inside a shared Form XObject does not survive', async () => {
  assert.match(rawPdf(fs.readFileSync(FIX + 'nested.pdf')), /\/Width 3\b/);
  await open('redact', ['nested.pdf']); await page.waitForSelector('.stage canvas');
  await page.fill('[aria-label="Text to find and redact"]', 'private'); await page.click('text=Mark all matches');
  await page.waitForSelector('text=/1 match/');
  const { buf } = await run();
  assert.doesNotMatch(rawPdf(buf), /\/Width 3\b/);
  assert.match(text(buf), /Nested two public/);
});
test('redact: image in a soft-mask group does not survive', async () => {
  assert.match(rawPdf(fs.readFileSync(FIX + 'smask.pdf')), /\/Width 3\b/);
  await open('redact', ['smask.pdf']); await page.waitForSelector('.stage canvas');
  await page.fill('[aria-label="Text to find and redact"]', 'private'); await page.click('text=Mark all matches');
  await page.waitForSelector('text=/1 match/');
  const { buf } = await run();
  assert.doesNotMatch(rawPdf(buf), /\/Width 3\b/);
  assert.match(text(buf), /Masked two public/);
});
test('redact: links and annotations pointing at a redacted page do not pull it back in', async () => {
  const hex = /Linked one private|4C696E6B6564206F6E652070726976617465/i;
  assert.match(rawPdf(fs.readFileSync(FIX + 'linked.pdf')), hex);
  await open('redact', ['linked.pdf']); await page.waitForSelector('.stage canvas');
  await page.fill('[aria-label="Text to find and redact"]', 'private'); await page.click('text=Mark all matches');
  await page.waitForSelector('text=/1 match/');
  const { buf } = await run();
  const raw = rawPdf(buf);
  assert.doesNotMatch(raw, hex);
  assert.equal((raw.match(/\/Type \/Page\b/g) || []).length, 2);
  assert.match(raw, /example\.com/); // web links survive
  assert.match(text(buf), /Linked two public/);
});
test('compare text', async () => { await open('compare', ['a.pdf', 'b.pdf']); const r = await run(); assert.match(r.buf.toString(), /Beta heading 1/); });
test('compare visual', async () => { await open('compare', ['a.pdf', 'b.pdf']); await page.click('.seg-btn:text("Visual overlay")'); assert.ok(isZip((await run()).buf)); });
test('pdf to markdown', async () => { await open('pdf-to-markdown', ['a.pdf']); assert.match((await run()).buf.toString(), /^# Alpha heading 1/m); });

// ---- local helper tools ----
test('compress', async () => { await open('compress', ['a.pdf']); await pdf((await run()).buf); });
test('repair', async () => { await open('repair', ['a.pdf']); assert.equal((await pdf((await run()).buf)).getPageCount(), 5); });
test('ocr makes a scan searchable', async () => { await open('ocr', ['scan.pdf']); assert.match(text((await run()).buf), /Secret/i); });
test('pdf/a', async () => { await open('pdf-to-pdfa', ['a.pdf']); assert.match((await run()).buf.toString('latin1'), /pdfaid/); });
test('protect then unlock', async () => {
  await open('protect', ['a.pdf']); await page.fill('#opt-pw', 'pässwörd'); await page.fill('#opt-pw2', 'pässwörd');
  const locked = await run();
  await assert.rejects(pdf(locked.buf), /encrypt/i);
  const f = path.join(FIX, 'locked.pdf'); fs.writeFileSync(f, locked.buf);
  await open('unlock', ['locked.pdf']); await page.fill('#opt-pw', 'wrong'); await assert.rejects(run(), /Wrong password/);
  await open('unlock', ['locked.pdf']); await page.fill('#opt-pw', 'pässwörd');
  assert.equal((await pdf((await run()).buf)).getPageCount(), 5);
  fs.rmSync(f);
});
test('protect: mismatched passwords', async () => { await open('protect', ['a.pdf']); await page.fill('#opt-pw', 'a'); await page.fill('#opt-pw2', 'b'); await assert.rejects(run(), /match/); });
for (const [id, file] of [['word-to-pdf', 'doc.docx'], ['excel-to-pdf', 'sheet.xlsx'], ['powerpoint-to-pdf', 'deck.pptx'], ['html-to-pdf', 'page.html']]) {
  test(id, { timeout: 240e3 }, async () => { await open(id, [file]); assert.ok((await pdf((await run()).buf)).getPageCount() >= 1); });
}
test('html file cannot read other local files', async () => {
  fs.writeFileSync(FIX + 'evil.html', '<!doctype html><header>x</header><p>visible</p><iframe src="file:///etc/hosts" width=600 height=400></iframe><script>document.write("JSRAN")</script>');
  fs.writeFileSync(FIX + 'evil2.html', '<meta http-equiv="refresh" content="0;url=file:///etc/hosts"><p>stayed</p>');
  await open('html-to-pdf', ['evil.html']);
  const t = text((await run()).buf);
  await open('html-to-pdf', ['evil2.html']);
  const t2 = text((await run()).buf);
  fs.rmSync(FIX + 'evil.html'); fs.rmSync(FIX + 'evil2.html');
  assert.match(t, /visible/); assert.doesNotMatch(t, /localhost|JSRAN/);
  assert.doesNotMatch(t2, /localhost/);
});
for (const id of ['pdf-to-word', 'pdf-to-excel', 'pdf-to-powerpoint']) {
  test(id, { timeout: 240e3 }, async () => { await open(id, ['a.pdf']); assert.ok(isZip((await run()).buf)); });
}
test('wrong file type is rejected', async () => { await page.goto(`${BASE}#/merge`); await page.setInputFiles('#file-in', FIX + 'img.png'); await page.waitForSelector('.alert.err'); });

test('no console errors and nothing contacted outside localhost', async () => {
  assert.deepEqual(errors.filter((e) => !/Failed to load resource.*(400|404)/.test(e)), []);
});
