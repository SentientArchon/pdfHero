import { PDFLib, h, loadPdfLib, loadPdfJs, renderPage, canvasBlob, embedImage, pdfBlob, baseName, UserError, PDFDocument } from '../lib.js';
import { serverTool, pageLines } from './convert.js';
import { pageEditor, applyItems } from '../editor.js';

const enc = encodeURIComponent;

export default [
  serverTool({
    id: 'protect', cat: 'security', icon: '🔒', name: 'Protect PDF', action: 'Encrypt', op: 'protect', outSuffix: '_protected',
    desc: 'Lock a PDF with a password (AES-256). Nobody can open it without the password.',
    options: () => [
      { key: 'pw', label: 'Password', type: 'password' },
      { key: 'pw2', label: 'Repeat password', type: 'password' },
    ],
    headers(o) {
      if (!o.pw) throw new UserError('Type a password.');
      if (o.pw !== o.pw2) throw new UserError('The two passwords don’t match.');
      return { 'X-Password': enc(o.pw) };
    },
  }),
  serverTool({
    id: 'unlock', cat: 'security', icon: '🔓', name: 'Unlock PDF', action: 'Unlock', op: 'unlock', outSuffix: '_unlocked',
    desc: 'Remove the password and restrictions from a PDF you have the right to open.',
    options: () => [{ key: 'pw', label: 'Password (if it needs one to open)', type: 'password', help: 'Files that only restrict printing or copying unlock without one.' }],
    headers: (o) => (o.pw ? { 'X-Password': enc(o.pw) } : {}),
  }),
  {
    id: 'sign', cat: 'security', icon: '✍', name: 'Sign PDF', action: 'Save signed PDF',
    desc: 'Draw, type or upload your signature and place it on the page, along with dates or initials.',
    async mount(ctx) {
      const pad = signaturePad();
      const ed = pageEditor(ctx.files[0], { tools: [
        { id: 'sig', label: 'Place signature', kind: 'image', width: 160, pick: async () => (await pad.get()) || (alert('Create your signature first (above).'), null) },
        { id: 'date', label: 'Date', kind: 'text', styled: true, text: () => new Date().toLocaleDateString() },
        { id: 'text', label: 'Text', kind: 'text', styled: true },
      ] });
      await ed.ready;
      return { el: h('div', { class: 'stack' }, pad.el, h('p', { class: 'muted' }, 'Then choose “Place signature” and click where it goes. Drag the corner to resize.'), ed.el), ed };
    },
    async run([f], o, ctx) {
      const items = ctx.custom.ed.state.items;
      if (!items.some((i) => i.type === 'image')) throw new UserError('Place your signature on the page first.');
      const doc = await loadPdfLib(f);
      await applyItems(doc, items);
      return [{ name: `${baseName(f.name)}_signed.pdf`, blob: await pdfBlob(doc) }];
    },
  },
  {
    id: 'redact', cat: 'security', icon: '▬', name: 'Redact PDF', action: 'Redact permanently',
    desc: 'Black out text and areas for good: redacted pages are flattened, so the hidden content is really gone.',
    options: () => [
      { key: 'dpi', label: 'Quality of redacted pages', type: 'seg', choices: [['150', 'Normal'], ['220', 'High']], default: '150' },
      { key: 'meta', label: 'Also remove document properties (title, author…)', type: 'checkbox', default: true },
    ],
    async mount(ctx) {
      const ed = pageEditor(ctx.files[0], { tools: [{ id: 'redact', label: 'Draw box', kind: 'box', type: 'redact' }] });
      const term = h('input', { class: 'input', type: 'search', placeholder: 'Word or phrase', 'aria-label': 'Text to find and redact' });
      const msg = h('span', { class: 'muted', 'aria-live': 'polite' });
      const find = h('button', { class: 'btn secondary sm', type: 'button', onclick: async () => {
        const n = await markMatches(ctx.files[0], term.value, ed); msg.textContent = n ? `${n} match(es) marked on all pages.` : 'No matches.';
      } }, 'Mark all matches');
      await ed.ready;
      return { el: h('div', { class: 'stack' }, h('div', { class: 'row gap-sm wrap' }, term, find, msg), ed.el), ed };
    },
    async run([f], o, ctx) {
      const items = ctx.custom.ed.state.items.filter((i) => i.type === 'redact');
      if (!items.length) throw new UserError('Mark at least one area to redact.');
      // Build a fresh document: saving the source would keep the removed pages' objects in the file.
      const src = await loadPdfLib(f);
      const js = await loadPdfJs(f);
      const doc = await PDFDocument.create();
      const hit = new Set(items.map((i) => i.page));
      const redactedStreams = streamPrints(src, hit); // before untouched pages are cleaned below
      for (let n = 1; n <= src.getPageCount(); n++) {
        if (!hit.has(n)) { detachPage(src.getPage(n - 1)); ownUsedResources(src.getPage(n - 1)); const [p] = await doc.copyPages(src, [n - 1]); doc.addPage(p); continue; }
        ctx.progress(`Flattening page ${n}…`);
        const page = await js.getPage(n);
        const k = +o.dpi / 72;
        const c = await renderPage(page, k);
        const g = c.getContext('2d'); g.fillStyle = '#000';
        for (const it of items.filter((i) => i.page === n)) g.fillRect(it.x * k, it.y * k, it.w * k, it.h * k);
        const img = await embedImage(doc, await canvasBlob(c, 'image/jpeg', 0.9));
        const vp = page.getViewport({ scale: 1 });
        doc.addPage([vp.width, vp.height]).drawImage(img, { x: 0, y: 0, width: vp.width, height: vp.height });
        c.width = 0;
      }
      if (!o.meta) {
        for (const k of ['Title', 'Author', 'Subject', 'Creator']) { const v = src[`get${k}`](); if (v) doc[`set${k}`](v); }
      }
      // fail closed: no stream only the redacted pages had may be in the output
      // (streams the cleaned untouched pages still use were visible on those pages anyway)
      const shown = streamPrints(src, [...Array(src.getPageCount()).keys()].map((i) => i + 1).filter((n) => !hit.has(n)));
      dropUnreachable(doc, new Set([...redactedStreams].filter((x) => !shown.has(x))));
      return [{ name: `${baseName(f.name)}_redacted.pdf`, blob: await pdfBlob(doc) }];
    },
  },
  {
    id: 'compare', cat: 'security', icon: '⇄', name: 'Compare PDF', action: 'Compare', multiple: true,
    desc: 'Spot the differences between two versions of a document, by text and by look.',
    options: () => [{ key: 'mode', label: 'Compare', type: 'seg', choices: [['text', 'Text'], ['visual', 'Visual overlay']], default: 'text' }],
    async run(files, o, ctx) {
      if (files.length !== 2) throw new UserError('Add exactly two PDFs: the old version first, then the new one.');
      const [a, b] = await Promise.all(files.map(loadPdfJs));
      const n = Math.max(a.numPages, b.numPages);
      if (o.mode === 'visual') {
        const view = h('div', { class: 'diff-visual' }, h('p', { class: 'muted' }, 'Dark = same. Bright = different.'));
        const out = [];
        for (let i = 1; i <= Math.min(n, 50); i++) {
          ctx.progress(`Page ${i} of ${n}…`);
          const ca = i <= a.numPages ? await renderPage(await a.getPage(i), 1) : null;
          const cb = i <= b.numPages ? await renderPage(await b.getPage(i), 1) : null;
          const c = h('canvas', { width: Math.max(ca?.width || 0, cb?.width || 0), height: Math.max(ca?.height || 0, cb?.height || 0), 'aria-label': `Difference on page ${i}` });
          const g = c.getContext('2d');
          g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
          if (ca) g.drawImage(ca, 0, 0);
          g.globalCompositeOperation = 'difference';
          if (cb) g.drawImage(cb, 0, 0); else { g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); }
          view.append(h('figure', {}, c, h('figcaption', {}, `Page ${i}`)));
          out.push({ name: `difference_page${i}.png`, blob: await canvasBlob(c) });
        }
        out[0].view = view;
        return out;
      }
      const rows = []; let changes = 0;
      for (let i = 1; i <= n; i++) {
        ctx.progress(`Reading page ${i} of ${n}…`);
        const la = i <= a.numPages ? (await pageLines(await a.getPage(i))).map((l) => l.text) : [];
        const lb = i <= b.numPages ? (await pageLines(await b.getPage(i))).map((l) => l.text) : [];
        const d = diffLines(la, lb);
        const changed = d.filter((x) => x[0] !== '=').length;
        changes += changed;
        rows.push({ page: i, d, changed });
      }
      const view = h('div', { class: 'diff' }, h('p', {}, changes ? `${changes} changed line(s).` : 'No text differences found.'),
        rows.filter((r) => r.changed).map((r) => h('section', {}, h('h3', {}, `Page ${r.page}`),
          h('ul', { class: 'diff-lines' }, r.d.filter((x) => x[0] !== '=').map(([op, t]) => h('li', { class: op === '+' ? 'add' : 'del' }, h('span', { class: 'sr-only' }, op === '+' ? 'Added: ' : 'Removed: '), `${op} ${t}`))))));
      const report = `<!doctype html><meta charset="utf-8"><title>Comparison</title><style>body{font:14px system-ui;max-width:900px;margin:2em auto}.add{background:#e6f6ea}.del{background:#fde8e8;text-decoration:line-through}li{list-style:none;padding:2px 6px}</style><h1>${esc(files[0].name)} → ${esc(files[1].name)}</h1>${view.innerHTML}`;
      return [{ name: 'comparison.html', blob: new Blob([report], { type: 'text/html' }), view }];
    },
  },
];

/**
 * Cut every reference from a page to other pages before it is copied: copyPages follows all
 * references, so an annotation's /P, a link's /Dest or a form field's /Parent would pull a
 * redacted page (and its content) into the output. Links to web addresses are kept.
 */
function detachPage(page) {
  const { PDFName, PDFDict, PDFArray, PDFRef, PDFString, PDFHexString, PDFNumber, PDFBool } = PDFLib;
  const N = PDFName.of; const ctx = page.node.context;
  // allowlist: everything else on the page dict is dropped (Parent stays so copyPages can resolve inherited boxes, then removes it)
  const PAGE_KEYS = ['Type', 'Parent', 'MediaBox', 'CropBox', 'BleedBox', 'TrimBox', 'ArtBox', 'Rotate', 'UserUnit', 'Contents', 'Resources', 'Annots', 'Group'];
  for (const k of page.node.keys()) {
    const name = k.asString().slice(1);
    // boxes, Rotate, Group…: must be plain values; only Parent/Contents/Resources/Annots may reference objects
    if (!PAGE_KEYS.includes(name) || (!['Parent', 'Contents', 'Resources', 'Annots'].includes(name) && hasRef(page.node.get(k)))) page.node.delete(k);
  }
  const annots = page.node.lookupMaybe(N('Annots'), PDFArray);
  if (!annots) return;
  const ANNOT_KEYS = ['Type', 'Subtype', 'Rect', 'Contents', 'F', 'AP', 'AS', 'Border', 'C', 'BS', 'QuadPoints', 'InkList', 'L', 'Vertices', 'IC', 'CA', 'M', 'T', 'DA', 'Q', 'MK', 'H'];
  const plain = (v) => v instanceof PDFString || v instanceof PDFHexString || v instanceof PDFNumber || v instanceof PDFBool || v instanceof PDFName;
  const kept = ctx.obj([]);
  for (const a of annots.asArray()) {
    const annot = ctx.lookup(a);
    if (!(annot instanceof PDFDict) || annot.lookupMaybe(N('Subtype'), PDFName) === N('Popup')) continue;
    const mine = ctx.obj({});
    for (const key of ANNOT_KEYS) {
      const v = annot.get(N(key));
      if (v === undefined) continue;
      if (key === 'AP') { // only the normal/rollover/down appearances; streams are rebuilt by ownUsedResources
        const ap = ctx.lookup(v);
        if (!(ap instanceof PDFDict)) continue;
        const myAp = ctx.obj({});
        for (const st of ['N', 'R', 'D']) if (ap.get(N(st)) !== undefined) myAp.set(N(st), ap.get(N(st)));
        mine.set(N(key), myAp);
        continue;
      }
      const val = ctx.lookup(v);
      // only direct values or plain arrays/dicts of numbers/names/strings: nothing that can point elsewhere
      if (plain(val) || ((val instanceof PDFArray || val instanceof PDFDict) && !hasRef(val))) mine.set(N(key), val instanceof PDFArray || val instanceof PDFDict ? val.clone(ctx) : val);
    }
    const action = annot.lookupMaybe(N('A'), PDFDict);
    const uri = action && action.lookupMaybe(N('S'), PDFName) === N('URI') ? ctx.lookup(action.get(N('URI'))) : null;
    if (uri instanceof PDFString || uri instanceof PDFHexString) mine.set(N('A'), ctx.obj({ S: 'URI', URI: PDFHexString.fromText(uri.decodeText()) })); // hex can't break out of the string
    kept.push(a instanceof PDFRef ? ctx.register(mine) : mine);
  }
  page.node.set(N('Annots'), kept);
}

function hasRef(v) {
  const { PDFRef, PDFArray, PDFDict } = PDFLib;
  if (v instanceof PDFRef) return true;
  if (v instanceof PDFArray) return v.asArray().some(hasRef);
  if (v instanceof PDFDict) return [...v.entries()].some(([, x]) => hasRef(x));
  return false;
}

/** Fingerprints of every stream reachable from these pages (not through /Parent or other pages). */
function streamPrints(src, pageNos) {
  const { PDFName, PDFArray, PDFDict, PDFRef, PDFRawStream } = PDFLib;
  const ctx = src.context; const out = new Set(); const seen = new Set();
  const walk = (v) => {
    if (v instanceof PDFRef) { if (seen.has(v)) return; seen.add(v); return walk(ctx.lookup(v)); }
    if (v instanceof PDFRawStream) { if (v.contents.length > 16) out.add(print(v.contents)); return walk(v.dict); }
    if (v instanceof PDFDict) {
      if (v.lookupMaybe(PDFName.of('Type'), PDFName) === PDFName.of('Page')) return; // stop at other pages
      for (const [k, x] of v.entries()) if (k !== PDFName.of('Parent')) walk(x);
      return;
    }
    if (v instanceof PDFArray) v.asArray().forEach(walk);
  };
  for (const n of pageNos) { const node = src.getPage(n - 1).node; for (const [k, x] of node.entries()) if (k !== PDFName.of('Parent')) walk(x); }
  return out;
}
function print(bytes) { let h = 2166136261; for (const b of bytes) h = Math.imul(h ^ b, 16777619) >>> 0; return `${bytes.length}:${h}`; }

/**
 * Fail closed: delete every object the new document does not reach (pdf-lib saves all objects in
 * its context), then refuse to save if any page dict outside the page tree is still reachable.
 */
function dropUnreachable(doc, forbidden = new Set()) {
  const { PDFDict, PDFArray, PDFRef, PDFStream, PDFName, PDFRawStream } = PDFLib;
  const ctx = doc.context;
  const seen = new Set();
  const walk = (v) => {
    if (v instanceof PDFRef) { if (seen.has(v)) return; seen.add(v); walk(ctx.lookup(v)); return; }
    if (v instanceof PDFStream) return walk(v.dict);
    if (v instanceof PDFDict) { for (const [, x] of v.entries()) walk(x); return; }
    if (v instanceof PDFArray) v.asArray().forEach(walk);
  };
  walk(ctx.trailerInfo.Root); walk(ctx.trailerInfo.Info);
  for (const [ref] of ctx.enumerateIndirectObjects()) if (!seen.has(ref)) ctx.delete(ref);
  const pages = new Set(doc.getPages().map((p) => p.ref));
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    if (obj instanceof PDFDict && obj.lookupMaybe(PDFName.of('Type'), PDFName) === PDFName.of('Page') && !pages.has(ref)) {
      throw new UserError('This PDF links its pages in a way that can’t be redacted safely. Nothing was saved.');
    }
    if (obj instanceof PDFRawStream && forbidden.has(print(obj.contents))) {
      throw new UserError('Content from a redacted page would have stayed in the file, so nothing was saved.');
    }
  }
}

/**
 * Give a page its own Resources holding only names its content uses, before copying it.
 * Pages often share Resources; without this, an image or font used only on a redacted page
 * would be copied along with an untouched page and survive in the file. Recurses into
 * Form XObjects, tiling patterns, Type 3 fonts, soft-mask groups and annotation appearances:
 * every kind of PDF object that can carry its own Resources.
 */
function ownUsedResources(page) {
  const { PDFName, PDFDict, PDFArray, PDFRawStream, PDFRef, decodePDFRawStream } = PDFLib;
  const ctx = page.node.context;
  const N = PDFName.of;
  // eslint-disable-next-line no-use-before-define -- hoisted helpers below
  const norm = (n) => n.replace(/#([0-9a-f]{2})/gi, (_, x) => String.fromCharCode(parseInt(x, 16)));
  const ops = (streams) => streams.map((st) => new TextDecoder('latin1').decode(st instanceof PDFRawStream ? decodePDFRawStream(st).decode() : st.getContents())).join('\n');
  const names = (text) => new Set((text.match(/\/[^\s/[\]()<>{}%]+/g) || []).map(norm));

  // Trim `res` to names used by `text`; returns a private copy. Streams it keeps are themselves cloned and trimmed.
  function trim(res, text, depth) {
    const used = names(text);
    const mine = ctx.obj({});
    const procSet = res.get(N('ProcSet'));
    if (procSet && !hasRef(procSet)) mine.set(N('ProcSet'), procSet);
    for (const cat of ['XObject', 'Font', 'ExtGState', 'Shading', 'Pattern', 'ColorSpace', 'Properties']) {
      if (!res.lookupMaybe(N(cat), PDFDict)) continue;
      mine.set(N(cat), res.lookupMaybe(N(cat), PDFDict));
      const kept = mine.lookupMaybe(N(cat), PDFDict).clone(ctx);
      for (const key of kept.keys()) {
        if (!used.has(norm(key.asString()))) { kept.delete(key); continue; }
        if (cat === 'XObject' || cat === 'Pattern') kept.set(key, ownStream(kept.get(key), depth));
        else if (cat === 'Font') kept.set(key, clean(ownType3(kept.get(key), depth), depth));
        else if (cat === 'ExtGState') kept.set(key, clean(ownSoftMask(kept.get(key), depth), depth));
        else kept.set(key, clean(kept.get(key), depth));
      }
      mine.set(N(cat), kept);
    }
    return mine;
  }

  // Any stream used for drawing (form, image, pattern, appearance, font file…): a copy whose dict keeps
  // only keys a renderer needs, with every value rebuilt by `clean`; Resources trimmed to what it uses.
  const STREAM_KEYS = new Set(['Type', 'Subtype', 'FormType', 'BBox', 'Matrix', 'Resources', 'Group', 'Filter', 'DecodeParms', 'Length',
    'Width', 'Height', 'BitsPerComponent', 'ColorSpace', 'Decode', 'ImageMask', 'Mask', 'SMask', 'SMaskInData', 'Interpolate', 'Intent',
    'PatternType', 'PaintType', 'TilingType', 'XStep', 'YStep', 'N', 'Alternate', 'Range', 'FunctionType', 'Domain', 'Size',
    'BitsPerSample', 'Order', 'Encode', 'ShadingType', 'Background', 'BitsPerCoordinate', 'BitsPerFlag', 'VerticesPerRow',
    'Function', 'Length1', 'Length2', 'Length3', 'K', 'Columns', 'Rows', 'EncodedByteAlign', 'BlackIs1', 'Predictor', 'Colors']);
  function ownStream(refOrObj, depth) {
    const st = ctx.lookup(refOrObj);
    if (!(st instanceof PDFRawStream)) return clean(refOrObj, depth);
    if (depth > 12) throw new UserError('This PDF nests its drawings too deeply to redact safely.');
    const dict = ctx.obj({});
    for (const [k, v] of st.dict.entries()) {
      const name = k.asString().slice(1);
      if (!STREAM_KEYS.has(name)) continue;
      if (name === 'Resources') { const r = ctx.lookup(v); if (r instanceof PDFDict) dict.set(k, trim(r, ops([st]), depth + 1)); continue; }
      dict.set(k, clean(v, depth + 1));
    }
    return ctx.register(PDFRawStream.of(dict, st.contents));
  }

  // Deep copy of any other value: navigation/link keys dropped, streams via ownStream, pages refused.
  const DROP = new Set(['Parent', 'P', 'Dest', 'Dests', 'A', 'AA', 'Popup', 'IRT', 'StructParent', 'StructParents', 'Metadata', 'PieceInfo', 'Thumb', 'B', 'Annots', 'Kids', 'Next', 'First', 'Last', 'Prev']);
  const cleaned = new Map();
  function clean(v, depth) {
    if (depth > 40) throw new UserError('This PDF nests its objects too deeply to redact safely.');
    if (v instanceof PDFRef) {
      if (cleaned.has(v)) return cleaned.get(v);
      const target = ctx.lookup(v);
      if (target instanceof PDFDict && target.lookupMaybe(N('Type'), PDFName) === N('Page')) throw new UserError('This PDF links its pages in a way that can’t be redacted safely. Nothing was saved.');
      const ref = ctx.nextRef(); cleaned.set(v, ref); // placeholder first: graphs can be cyclic
      const out = target instanceof PDFRawStream ? ctx.lookup(ownStream(target, depth)) : clean(target, depth);
      ctx.assign(ref, out);
      return ref;
    }
    if (v instanceof PDFRawStream) return ownStream(v, depth);
    if (v instanceof PDFDict) {
      const d = ctx.obj({});
      for (const [k, x] of v.entries()) if (!DROP.has(k.asString().slice(1))) d.set(k, clean(x, depth + 1));
      return d;
    }
    if (v instanceof PDFArray) { const a = ctx.obj([]); v.asArray().forEach((x) => a.push(clean(x, depth + 1))); return a; }
    return v; // numbers, names, strings, booleans, null
  }

  // Type 3 fonts draw glyphs with CharProcs streams that use the font's own Resources.
  function ownType3(ref, depth) {
    // Any font dict with its own Resources is trimmed, whatever its Subtype says (or how it is encoded).
    const font = ctx.lookup(ref);
    if (!(font instanceof PDFDict)) return ref;
    const res = font.lookupMaybe(N('Resources'), PDFDict);
    const procs = font.lookupMaybe(N('CharProcs'), PDFDict);
    if (!res) return ref;
    if (depth > 12) throw new UserError('This PDF nests its drawings too deeply to redact safely.');
    const glyphs = procs ? procs.keys().map((k) => ctx.lookup(procs.get(k))).filter((x) => x instanceof PDFRawStream) : [];
    const copy = font.clone(ctx);
    copy.set(N('Resources'), trim(res, ops(glyphs), depth + 1));
    return ctx.register(copy);
  }

  // A graphics state's soft mask paints a transparency group (/G), which is a Form XObject.
  function ownSoftMask(ref, depth) {
    const gs = ctx.lookup(ref);
    const mask = gs instanceof PDFDict && gs.lookupMaybe(N('SMask'), PDFDict);
    if (!mask || !mask.get(N('G'))) return ref;
    const myMask = mask.clone(ctx);
    myMask.set(N('G'), ownStream(mask.get(N('G')), depth));
    const myGs = gs.clone(ctx);
    myGs.set(N('SMask'), myMask);
    return ctx.register(myGs);
  }

  const contents = ctx.lookup(page.node.get(N('Contents')));
  const streams = contents instanceof PDFArray ? contents.asArray().map((r) => ctx.lookup(r)) : contents ? [contents] : [];
  const res = page.node.Resources();
  if (res) page.node.set(N('Resources'), trim(res, ops(streams), 0));

  // Annotation appearance streams (/AP /N /R /D, each a stream or a dict of state -> stream)
  const annots = page.node.lookupMaybe(N('Annots'), PDFArray);
  for (const a of annots ? annots.asArray() : []) {
    const annot = ctx.lookup(a);
    const ap = annot instanceof PDFDict && annot.lookupMaybe(N('AP'), PDFDict);
    if (!ap) continue;
    const myAp = ap.clone(ctx);
    for (const k of myAp.keys()) {
      const v = ctx.lookup(myAp.get(k));
      if (v instanceof PDFDict && !(v instanceof PDFRawStream)) {
        const states = v.clone(ctx);
        for (const sk of states.keys()) states.set(sk, ownStream(states.get(sk), 0));
        myAp.set(k, states);
      } else myAp.set(k, ownStream(myAp.get(k), 0));
    }
    const myAnnot = annot.clone(ctx);
    myAnnot.set(N('AP'), myAp);
    annots.set(annots.asArray().indexOf(a), a instanceof PDFRef ? ctx.register(myAnnot) : myAnnot);
  }
}

const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** Line diff via LCS. Returns [['=',line] | ['-',line] | ['+',line]]. */
export function diffLines(a, b) {
  const m = a.length; const n = b.length;
  const L = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1));
  for (let i = m - 1; i >= 0; i--) for (let j = n - 1; j >= 0; j--) L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out = []; let i = 0; let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) { out.push(['=', a[i]]); i++; j++; } else if (L[i + 1][j] >= L[i][j + 1]) out.push(['-', a[i++]]); else out.push(['+', b[j++]]);
  }
  while (i < m) out.push(['-', a[i++]]);
  while (j < n) out.push(['+', b[j++]]);
  return out;
}

async function markMatches(file, term, ed) {
  term = term.trim().toLowerCase();
  if (!term) return 0;
  const doc = await loadPdfJs(file);
  let count = 0;
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const vp = page.getViewport({ scale: 1 });
    for (const it of (await page.getTextContent()).items) {
      const s = (it.str || '').toLowerCase();
      if (!s) continue;
      const size = Math.hypot(it.transform[2], it.transform[3]);
      for (let k = s.indexOf(term); k >= 0; k = s.indexOf(term, k + term.length)) {
        const [x0, y0] = vp.convertToViewportPoint(it.transform[4] + (it.width * k) / s.length, it.transform[5]);
        const w = (it.width * term.length) / s.length;
        ed.state.items.push({ id: Math.random(), page: p, type: 'redact', x: x0 - 1, y: y0 - size * 0.95, w: w + 2, h: size * 1.2 });
        count++;
      }
    }
  }
  ed.redraw();
  return count;
}

function signaturePad() {
  let mode = 'draw';
  const color = h('input', { type: 'color', value: '#1a2b8c', 'aria-label': 'Ink colour' });
  const canvas = h('canvas', { width: 600, height: 180, class: 'sig-canvas', 'aria-label': 'Draw your signature here' });
  const g = canvas.getContext('2d');
  let drawn = false;
  canvas.addEventListener('pointerdown', (e) => {
    if (mode !== 'draw') return;
    const r = canvas.getBoundingClientRect(); const k = canvas.width / r.width;
    g.strokeStyle = color.value; g.lineWidth = 3; g.lineCap = g.lineJoin = 'round';
    g.beginPath(); g.moveTo((e.clientX - r.left) * k, (e.clientY - r.top) * k);
    const mv = (ev) => { g.lineTo((ev.clientX - r.left) * k, (ev.clientY - r.top) * k); g.stroke(); drawn = true; };
    const up = () => { canvas.removeEventListener('pointermove', mv); removeEventListener('pointerup', up); };
    canvas.setPointerCapture(e.pointerId);
    canvas.addEventListener('pointermove', mv); addEventListener('pointerup', up);
  });
  const typed = h('input', { class: 'input', placeholder: 'Type your name', 'aria-label': 'Your name' });
  const font = h('select', { class: 'input', 'aria-label': 'Signature style' },
    ['Snell Roundhand', 'Brush Script MT', 'Apple Chancery', 'Zapfino', 'Bradley Hand', 'cursive'].map((f) => h('option', { value: f }, f)));
  const upload = h('input', { type: 'file', accept: 'image/*', class: 'input', 'aria-label': 'Signature image' });
  const panes = {
    draw: h('div', {}, canvas, h('button', { class: 'btn ghost sm', type: 'button', onclick: () => { g.clearRect(0, 0, canvas.width, canvas.height); drawn = false; } }, 'Clear')),
    type: h('div', { class: 'row gap-sm wrap' }, typed, font),
    upload: h('div', {}, upload, h('small', { class: 'muted' }, 'A PNG with a transparent background looks best.')),
  };
  const tabs = h('div', { class: 'seg', role: 'tablist' }, Object.keys(panes).map((k) => h('button', {
    class: 'seg-btn', type: 'button', role: 'tab', 'aria-selected': String(k === mode),
    onclick: (e) => { mode = k; tabs.querySelectorAll('button').forEach((b) => b.setAttribute('aria-selected', String(b === e.currentTarget))); Object.entries(panes).forEach(([n, p]) => { p.hidden = n !== k; }); },
  }, k[0].toUpperCase() + k.slice(1))));
  Object.entries(panes).forEach(([n, p]) => { p.hidden = n !== mode; });

  async function get() {
    if (mode === 'upload') return upload.files[0] || null;
    if (mode === 'type') {
      if (!typed.value.trim()) return null;
      const c = h('canvas', { width: 900, height: 220 }); const x = c.getContext('2d');
      x.font = `110px "${font.value}", cursive`; x.fillStyle = color.value; x.textBaseline = 'middle';
      c.width = Math.ceil(x.measureText(typed.value).width) + 40;
      x.font = `110px "${font.value}", cursive`; x.fillStyle = color.value; x.textBaseline = 'middle';
      x.fillText(typed.value, 20, 115);
      return trim(c);
    }
    return drawn ? trim(canvas) : null;
  }
  return { el: h('section', { class: 'sig-pad panel-inline', 'aria-label': 'Your signature' }, h('div', { class: 'row gap-sm wrap' }, h('strong', {}, 'Your signature'), tabs, color), ...Object.values(panes)), get };
}

/** Crop transparent edges off a canvas and return a PNG blob. */
async function trim(c) {
  const { data, width, height } = c.getContext('2d').getImageData(0, 0, c.width, c.height);
  let x0 = width; let y0 = height; let x1 = 0; let y1 = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (data[(y * width + x) * 4 + 3] > 8) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  if (x1 < x0) return null;
  const out = h('canvas', { width: x1 - x0 + 8, height: y1 - y0 + 8 });
  out.getContext('2d').drawImage(c, x0 - 4, y0 - 4, out.width, out.height, 0, 0, out.width, out.height);
  return canvasBlob(out);
}
