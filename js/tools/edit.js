import { h, loadPdfLib, pdfBlob, pageFilter, baseName, UserError, degrees, StandardFonts, hexToRgb, safeText, embedImage, PDFLib } from '../lib.js';
import { pageEditor, applyItems } from '../editor.js';

const pagesOpts = [
  { key: 'which', label: 'Pages', type: 'select', choices: [['all', 'All pages'], ['odd', 'Odd pages'], ['even', 'Even pages'], ['custom', 'Custom…']], default: 'all' },
  { key: 'custom', label: 'Which pages', placeholder: '1-3, 7', show: (o) => o.which === 'custom' },
];
const POS = [['tl', 'Top left'], ['tc', 'Top centre'], ['tr', 'Top right'], ['ml', 'Middle left'], ['mc', 'Centre'], ['mr', 'Middle right'], ['bl', 'Bottom left'], ['bc', 'Bottom centre'], ['br', 'Bottom right']];

/** Place a w×h box at a 9-grid position inside a page box with a margin. */
function place(pos, box, w, hgt, m) {
  const x = pos[1] === 'l' ? box.x + m : pos[1] === 'r' ? box.x + box.width - w - m : box.x + (box.width - w) / 2;
  const y = pos[0] === 't' ? box.y + box.height - hgt - m : pos[0] === 'b' ? box.y + m : box.y + (box.height - hgt) / 2;
  return { x, y };
}

export default [
  {
    id: 'rotate', cat: 'edit', icon: '⟳', name: 'Rotate PDF', action: 'Rotate', multiple: true,
    desc: 'Turn pages 90°, 180° or 270°, all at once or only the ones you pick.',
    options: () => [{ key: 'angle', label: 'Turn', type: 'seg', choices: [['90', '90° right'], ['180', '180°'], ['270', '90° left']], default: '90' }, ...pagesOpts],
    async run(files, o) {
      return Promise.all(files.map(async (f) => {
        const doc = await loadPdfLib(f);
        for (const i of pageFilter(o.which, o.custom, doc.getPageCount())) {
          const p = doc.getPage(i); p.setRotation(degrees((p.getRotation().angle + +o.angle) % 360));
        }
        return { name: `${baseName(f.name)}_rotated.pdf`, blob: await pdfBlob(doc) };
      }));
    },
  },
  {
    id: 'page-numbers', cat: 'edit', icon: '#', name: 'Add page numbers', action: 'Add numbers',
    desc: 'Stamp page numbers where you want them, in the format you want.',
    options: () => [
      { key: 'pos', label: 'Position', type: 'select', choices: POS.filter((p) => p[0][0] !== 'm'), default: 'bc' },
      { key: 'format', label: 'Format', type: 'select', choices: [['{n}', '1'], ['Page {n}', 'Page 1'], ['{n} / {total}', '1 / 9'], ['Page {n} of {total}', 'Page 1 of 9'], ['custom', 'Custom…']], default: '{n}' },
      { key: 'customFmt', label: 'Custom text', default: '- {n} -', help: '{n} = page number, {total} = page count', show: (o) => o.format === 'custom' },
      { key: 'start', label: 'First number', type: 'number', min: 0, default: 1 },
      { key: 'skipFirst', label: 'Skip the first page (cover)', type: 'checkbox' },
      { key: 'size', label: 'Font size', type: 'number', min: 6, max: 72, default: 11 },
      { key: 'color', label: 'Colour', type: 'color', default: '#000000' },
      { key: 'margin', label: 'Margin (pt)', type: 'number', min: 0, default: 24 },
      ...pagesOpts,
    ],
    async run([f], o) {
      const doc = await loadPdfLib(f);
      const font = await doc.embedFont(StandardFonts.Helvetica);
      const idx = pageFilter(o.which, o.custom, doc.getPageCount()).filter((i) => !(o.skipFirst && i === 0));
      const fmt = o.format === 'custom' ? o.customFmt : o.format;
      idx.forEach((i, k) => {
        const page = doc.getPage(i);
        const text = safeText(font, fmt.replace(/\{n\}/g, String(o.start + k)).replace(/\{total\}/g, String(idx.length + o.start - 1)));
        const w = font.widthOfTextAtSize(text, o.size);
        const { x, y } = place(o.pos, page.getCropBox(), w, o.size, o.margin);
        page.drawText(text, { x, y, size: o.size, font, color: hexToRgb(o.color) });
      });
      return [{ name: `${baseName(f.name)}_numbered.pdf`, blob: await pdfBlob(doc) }];
    },
  },
  {
    id: 'watermark', cat: 'edit', icon: '≋', name: 'Add watermark', action: 'Add watermark',
    desc: 'Lay text or an image over (or under) your pages, at any angle and opacity.',
    options: () => [
      { key: 'kind', label: 'Watermark', type: 'seg', choices: [['text', 'Text'], ['image', 'Image']], default: 'text' },
      { key: 'text', label: 'Text', default: 'CONFIDENTIAL', show: (o) => o.kind === 'text' },
      { key: 'font', label: 'Font', type: 'select', choices: [['HelveticaBold', 'Helvetica Bold'], ['Helvetica', 'Helvetica'], ['TimesRomanBold', 'Times Bold'], ['CourierBold', 'Courier Bold']], show: (o) => o.kind === 'text' },
      { key: 'size', label: 'Font size', type: 'number', min: 6, max: 300, default: 60, show: (o) => o.kind === 'text' },
      { key: 'color', label: 'Colour', type: 'color', default: '#c0392b', show: (o) => o.kind === 'text' },
      { key: 'image', label: 'Image', type: 'file', accept: 'image/*', show: (o) => o.kind === 'image' },
      { key: 'scale', label: 'Image width (% of page)', type: 'number', min: 5, max: 100, default: 40, show: (o) => o.kind === 'image' },
      { key: 'pos', label: 'Position', type: 'select', choices: [...POS, ['tile', 'Tile (repeat)']], default: 'mc' },
      { key: 'rotate', label: 'Rotation', type: 'select', choices: [['0', '0°'], ['45', '45°'], ['90', '90°'], ['-45', '−45°']], default: '45' },
      { key: 'opacity', label: 'Opacity (%)', type: 'range', min: 5, max: 100, default: 30 },
      { key: 'under', label: 'Put it behind the page content', type: 'checkbox' },
      ...pagesOpts,
    ],
    async run([f], o) {
      const doc = await loadPdfLib(f);
      let draw;
      if (o.kind === 'image') {
        if (!o.image) throw new UserError('Choose an image for the watermark.');
        const img = await embedImage(doc, o.image);
        draw = (page, box) => {
          const w = (box.width * o.scale) / 100; const hgt = (w * img.height) / img.width;
          return [w, hgt, (x, y) => page.drawImage(img, { x, y, width: w, height: hgt, opacity: o.opacity / 100, rotate: degrees(+o.rotate) })];
        };
      } else {
        if (!o.text.trim()) throw new UserError('Type the watermark text.');
        const font = await doc.embedFont(StandardFonts[o.font] || StandardFonts.HelveticaBold);
        const text = safeText(font, o.text);
        draw = (page) => {
          const w = font.widthOfTextAtSize(text, o.size);
          return [w, o.size, (x, y) => page.drawText(text, { x, y, size: o.size, font, color: hexToRgb(o.color), opacity: o.opacity / 100, rotate: degrees(+o.rotate) })];
        };
      }
      for (const i of pageFilter(o.which, o.custom, doc.getPageCount())) {
        const page = doc.getPage(i);
        const box = page.getCropBox();
        const [w, hgt, paint] = draw(page, box);
        const r = (+o.rotate * Math.PI) / 180;
        // rotation pivots on the bottom-left corner; shift so the box centre lands where we want it
        const at = (cx, cy) => paint(cx - (w / 2) * Math.cos(r) + (hgt / 2) * Math.sin(r), cy - (w / 2) * Math.sin(r) - (hgt / 2) * Math.cos(r));
        if (o.pos === 'tile') {
          const step = Math.max(w, hgt) * 1.4;
          for (let y = box.y; y < box.y + box.height + step; y += step) for (let x = box.x; x < box.x + box.width + step; x += step) at(x, y);
        } else {
          const p = place(o.pos, box, w, hgt, 36);
          at(p.x + w / 2, p.y + hgt / 2);
        }
        if (o.under) moveLastStreamToBack(page);
      }
      return [{ name: `${baseName(f.name)}_watermarked.pdf`, blob: await pdfBlob(doc) }];
    },
  },
  {
    id: 'crop', cat: 'edit', icon: '⌗', name: 'Crop PDF', action: 'Crop',
    desc: 'Drag a box over the area to keep. Apply it to one page or every page.',
    options: () => [{ key: 'scope', label: 'Apply to', type: 'seg', choices: [['all', 'All pages'], ['this', 'Only the page shown']], default: 'all' }],
    async mount(ctx) {
      const ed = pageEditor(ctx.files[0], { tools: [{ id: 'crop', label: 'Draw crop area', kind: 'box', type: 'crop', single: true }] });
      await ed.ready;
      return { el: h('div', {}, h('p', { class: 'muted' }, 'Drag on the page to mark what stays.'), ed.el), ed };
    },
    async run([f], o, ctx) {
      const box = ctx.custom.ed.state.items.find((i) => i.type === 'crop');
      if (!box) throw new UserError('Drag a crop area on the page first.');
      const doc = await loadPdfLib(f);
      const idx = o.scope === 'this' ? [box.page - 1] : doc.getPageIndices();
      for (const i of idx) {
        const page = doc.getPage(i);
        const cb = page.getCropBox();
        const rect = [cb.x + box.x, cb.y + cb.height - box.y - box.h, box.w, box.h];
        page.setCropBox(...rect); page.setMediaBox(...rect);
      }
      return [{ name: `${baseName(f.name)}_cropped.pdf`, blob: await pdfBlob(doc) }];
    },
  },
  {
    id: 'edit-pdf', cat: 'edit', icon: '✎', name: 'Edit PDF', action: 'Save changes',
    desc: 'Add text, pictures, shapes, freehand drawing, or white-out over existing content.',
    async mount(ctx) {
      const pickImage = () => new Promise((res) => {
        const i = h('input', { type: 'file', accept: 'image/*', onchange: () => res(i.files[0] || null) }); i.click();
      });
      const ed = pageEditor(ctx.files[0], { defaultTool: 'edittext', tools: [
        { id: 'edittext', label: 'Edit text', kind: 'edittext', styled: true, hint: 'Click any text on the page to change it' },
        { id: 'text', label: 'Add text', kind: 'text', styled: true },
        { id: 'image', label: 'Image', kind: 'image', pick: pickImage, hint: 'Pick an image, then click the page' },
        { id: 'rect', label: 'Rectangle', kind: 'box', type: 'rect', styled: true },
        { id: 'ellipse', label: 'Ellipse', kind: 'box', type: 'ellipse', styled: true },
        { id: 'draw', label: 'Draw', kind: 'draw', styled: true },
        { id: 'whiteout', label: 'White-out', kind: 'box', type: 'whiteout' },
      ] });
      await ed.ready;
      return { el: h('div', {}, h('p', { class: 'muted' }, '“Edit text”: click existing text to change it (remove the edit with × to restore the original). Other tools: click or drag on the page; select an item and press Delete to remove it. Edited text is drawn over the original, which stays underneath; use Redact PDF to remove sensitive text. Standard fonts cover Latin text only.'), ed.el), ed };
    },
    async run([f], o, ctx) {
      const items = ctx.custom.ed.state.items;
      if (!items.length) throw new UserError('Add something to the page first.');
      const doc = await loadPdfLib(f);
      await applyItems(doc, items);
      return [{ name: `${baseName(f.name)}_edited.pdf`, blob: await pdfBlob(doc) }];
    },
  },
  {
    id: 'forms', cat: 'edit', icon: '☑', name: 'PDF Forms', action: 'Save form',
    desc: 'Fill in the fields of a fillable PDF, and optionally flatten them so they can’t be changed.',
    options: () => [{ key: 'flatten', label: 'Flatten (make answers permanent)', type: 'checkbox' }],
    async mount(ctx) {
      const doc = await loadPdfLib(ctx.files[0]);
      const fields = doc.getForm().getFields();
      if (!fields.length) return { el: h('div', { class: 'alert warn' }, 'This PDF has no fillable fields. Use Edit PDF to type on it instead.'), fields: [] };
      const inputs = fields.map((fl, i) => {
        const name = fl.getName(); const id = `ff-${i}`; const T = ['PDFCheckBox', 'PDFDropdown', 'PDFOptionList', 'PDFRadioGroup', 'PDFTextField'].find((k) => fl instanceof PDFLib[k]);
        let input;
        if (T === 'PDFCheckBox') input = h('input', { id, type: 'checkbox', checked: fl.isChecked() });
        else if (T === 'PDFDropdown' || T === 'PDFOptionList') input = h('select', { id, class: 'input' }, h('option', { value: '' }, '—'), fl.getOptions().map((v) => h('option', { value: v, selected: fl.getSelected().includes(v) }, v)));
        else if (T === 'PDFRadioGroup') input = h('select', { id, class: 'input' }, h('option', { value: '' }, '—'), fl.getOptions().map((v) => h('option', { value: v, selected: fl.getSelected() === v }, v)));
        else if (T === 'PDFTextField') input = h(fl.isMultiline() ? 'textarea' : 'input', { id, class: 'input', value: fl.getText() || '' }, fl.isMultiline() ? fl.getText() || '' : null);
        else return null;
        return { name, T, input, row: h('div', { class: T === 'PDFCheckBox' ? 'opt check' : 'opt' }, T === 'PDFCheckBox' ? input : null, h('label', { for: id }, name), T === 'PDFCheckBox' ? null : input) };
      }).filter(Boolean);
      return { el: h('div', { class: 'form-fields' }, h('h2', {}, `${inputs.length} field(s)`), inputs.map((i) => i.row)), fields: inputs };
    },
    async run([f], o, ctx) {
      if (!ctx.custom.fields.length) throw new UserError('This PDF has no fillable fields.');
      const doc = await loadPdfLib(f);
      const form = doc.getForm();
      for (const { name, T, input } of ctx.custom.fields) {
        const fl = form.getField(name);
        if (T === 'PDFCheckBox') input.checked ? fl.check() : fl.uncheck();
        else if (T === 'PDFTextField') fl.setText(input.value);
        else if (input.value) fl.select(input.value);
      }
      const font = await doc.embedFont(StandardFonts.Helvetica);
      form.updateFieldAppearances(font);
      if (o.flatten) form.flatten();
      return [{ name: `${baseName(f.name)}_filled.pdf`, blob: await pdfBlob(doc) }];
    },
  },
];

// Draw ops are appended as the page's last content stream; move it first so it paints underneath.
function moveLastStreamToBack(page) {
  const { PDFArray, PDFName } = PDFLib;
  const contents = page.node.get(PDFName.of('Contents'));
  const arr = page.node.context.lookup(contents);
  if (!(arr instanceof PDFArray) || arr.size() < 2) return;
  const last = arr.get(arr.size() - 1);
  arr.remove(arr.size() - 1);
  arr.insert(0, last);
}
