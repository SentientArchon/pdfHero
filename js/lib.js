// Shared helpers: PDF loading/rendering, page ranges, downloads, server calls, small DOM utils.
import * as pdfjs from '../vendor/pdfjs/build/pdf.min.mjs';
import * as PDFLib from '../vendor/pdf-lib.js';

// Relative to this file, so the site works under any path (e.g. user.github.io/pdfHero/).
export const VENDOR = new URL('../vendor/', import.meta.url).href;
pdfjs.GlobalWorkerOptions.workerSrc = `${VENDOR}pdfjs/build/pdf.worker.min.mjs`;
export { pdfjs, PDFLib };
export const { PDFDocument, degrees, rgb, StandardFonts } = PDFLib;

export class UserError extends Error {}

// ---------- DOM ----------
export function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : document.createTextNode(kid));
  return el;
}

export const sizeLabel = (n) => n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1)} MB`;
export const baseName = (name) => name.replace(/\.[^.]+$/, '');
export const bytesOf = async (file) => new Uint8Array(await file.arrayBuffer());

// ---------- PDF ----------
export async function loadPdfLib(file, opts = {}) {
  try {
    return await PDFDocument.load(await bytesOf(file), { updateMetadata: false, ...opts });
  } catch (e) {
    if (/encrypt/i.test(e.message)) throw new UserError(`"${file.name}" is password-protected. Use Unlock PDF first.`);
    throw new UserError(`"${file.name}" could not be read as a PDF.`);
  }
}

const docCache = new WeakMap();
export async function loadPdfJs(file) {
  if (docCache.has(file)) return docCache.get(file);
  const p = (async () => {
    const data = await bytesOf(file);
    try {
      return await pdfjs.getDocument({
        data, isEvalSupported: false, fontExtraProperties: true /* keeps font names for Edit text */, cMapUrl: `${VENDOR}pdfjs/cmaps/`, cMapPacked: true,
        standardFontDataUrl: `${VENDOR}pdfjs/standard_fonts/`, wasmUrl: `${VENDOR}pdfjs/wasm/`, iccUrl: `${VENDOR}pdfjs/iccs/`,
      }).promise;
    } catch (e) {
      if (e.name === 'PasswordException') throw new UserError(`"${file.name}" is password-protected. Use Unlock PDF first.`);
      throw new UserError(`"${file.name}" could not be read as a PDF.`);
    }
  })();
  docCache.set(file, p);
  p.catch(() => docCache.delete(file));
  return p;
}

/** Render a pdf.js page to a canvas. `scale` is CSS pixels per PDF point. */
export async function renderPage(page, scale, rotation = 0) {
  const viewport = page.getViewport({ scale, rotation: (page.rotate + rotation) % 360 });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  await page.render({ canvas, canvasContext: canvas.getContext('2d'), viewport }).promise;
  return canvas;
}

export async function thumbnail(file, pageNo, width = 160) {
  const doc = await loadPdfJs(file);
  const page = await doc.getPage(pageNo);
  const vp = page.getViewport({ scale: 1 });
  return renderPage(page, width / vp.width);
}

export const canvasBlob = (canvas, type = 'image/png', q = 0.92) => new Promise((r) => canvas.toBlob(r, type, q));

/** "1-3, 5, 8-" -> [0,1,2,4,7,8,...] zero-based, in order given, de-duplicated. */
export function parseRanges(text, total) {
  const out = [];
  const seen = new Set();
  const parts = String(text || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!parts.length) throw new UserError('Enter the pages, for example 1-3, 5.');
  for (const part of parts) {
    const m = part.match(/^(\d*)\s*(?:-\s*(\d*))?$/);
    if (!m || (!m[1] && !m[2] && !part.includes('-'))) throw new UserError(`"${part}" is not a page or range.`);
    const a = m[1] ? +m[1] : 1;
    const b = part.includes('-') ? (m[2] ? +m[2] : total) : a;
    if (a < 1 || b > total || a > b) throw new UserError(`"${part}" is outside 1–${total}.`);
    for (let i = a; i <= b; i++) if (!seen.has(i)) { seen.add(i); out.push(i - 1); }
  }
  return out;
}

/** Ranges as groups: "1-3, 5" -> [[0,1,2],[4]]. */
export function parseRangeGroups(text, total) {
  return String(text).split(',').map((s) => s.trim()).filter(Boolean).map((p) => parseRanges(p, total));
}

export function pageFilter(mode, custom, total) {
  const all = [...Array(total).keys()];
  if (mode === 'odd') return all.filter((i) => i % 2 === 0);
  if (mode === 'even') return all.filter((i) => i % 2 === 1);
  if (mode === 'custom') return parseRanges(custom, total);
  return all;
}

export async function pdfBlob(doc) {
  return new Blob([await doc.save()], { type: 'application/pdf' });
}

export function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

/** Make any image file/blob embeddable by pdf-lib (it only takes JPG/PNG). */
export async function embedImage(doc, blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (blob.type === 'image/jpeg' || (bytes[0] === 0xff && bytes[1] === 0xd8)) return doc.embedJpg(bytes);
  if (blob.type === 'image/png' || (bytes[0] === 0x89 && bytes[1] === 0x50)) return doc.embedPng(bytes);
  const bmp = await createImageBitmap(blob);
  const c = document.createElement('canvas');
  c.width = bmp.width; c.height = bmp.height;
  c.getContext('2d').drawImage(bmp, 0, 0);
  return doc.embedPng(new Uint8Array(await (await canvasBlob(c)).arrayBuffer()));
}

// Standard fonts are WinAnsi only; replace what they cannot draw instead of crashing.
export function safeText(font, text) {
  return [...text].map((ch) => { try { font.encodeText(ch); return ch; } catch { return '?'; } }).join('');
}

// ---------- results ----------
export function download(blob, name) {
  const a = h('a', { href: URL.createObjectURL(blob), download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60e3);
}

export async function zip(results, name) {
  const z = new window.JSZip();
  const used = new Set();
  for (const r of results) {
    let n = r.name; let i = 1;
    while (used.has(n)) n = r.name.replace(/(\.[^.]+)?$/, `-${i++}$1`);
    used.add(n);
    z.file(n, r.blob);
  }
  return { name, blob: await z.generateAsync({ type: 'blob' }) };
}

// ---------- WebAssembly engines (Ghostscript, qpdf) ----------
/**
 * Run a command-line engine in its own Web Worker. `files` are written to its virtual disk,
 * `outputs` read back after. A fresh worker per job keeps memory from piling up.
 */
export function runWasm(engine, args, files, outputs) {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL('./engines/wasm-worker.js', import.meta.url));
    w.onmessage = ({ data }) => { w.terminate(); data.error ? reject(new Error(data.error)) : resolve(data); };
    w.onerror = (e) => { w.terminate(); reject(new Error(e.message || 'Engine failed to start.')); };
    w.postMessage({ engine, base: VENDOR, args, files, outputs }); // copied, not transferred: callers may reuse their bytes
  });
}
