"""PDF -> Word / Excel / PowerPoint. Usage: convert.py word|excel|ppt in.pdf out.ext"""
import os
import subprocess
import sys
import tempfile


def to_word(src, dst):
    from pdf2docx import Converter
    cv = Converter(src)
    try:
        cv.convert(dst)
    finally:
        cv.close()


def to_excel(src, dst):
    import pdfplumber
    from openpyxl import Workbook

    wb = Workbook()
    wb.remove(wb.active)
    with pdfplumber.open(src) as pdf:
        for n, page in enumerate(pdf.pages, 1):
            tables = page.extract_tables()
            if not tables:
                # shortcut: no ruled table found, fall back to one row per text line split on wide gaps
                text = page.extract_text(layout=True) or ''
                rows = [[c.strip() for c in __import__('re').split(r'\s{3,}', line.strip())] for line in text.splitlines() if line.strip()]
                tables = [rows] if rows else []
            for t, table in enumerate(tables, 1):
                ws = wb.create_sheet(f'Page {n}' + (f' ({t})' if len(tables) > 1 else ''))
                for row in table:
                    ws.append([_num(c) for c in row])
    if not wb.sheetnames:
        wb.create_sheet('Empty').append(['No text found. Run OCR first if this is a scan.'])
    wb.save(dst)


def _num(cell):
    if cell is None:
        return None
    s = str(cell).strip()
    try:
        return float(s.replace(',', '')) if s and s.replace(',', '').replace('.', '', 1).lstrip('-').isdigit() else s
    except ValueError:
        return s


def to_ppt(src, dst):
    from pptx import Presentation
    from pptx.util import Emu

    with tempfile.TemporaryDirectory() as tmp:
        subprocess.run(['gs', '-sDEVICE=png16m', '-r150', '-dNOPAUSE', '-dQUIET', '-dBATCH',
                        '-dTextAlphaBits=4', '-dGraphicsAlphaBits=4',
                        f'-sOutputFile={tmp}/p%04d.png', src], check=True)
        pages = sorted(os.listdir(tmp))
        prs = Presentation()
        from PIL import Image  # python-pptx depends on Pillow
        w, h = Image.open(os.path.join(tmp, pages[0])).size
        prs.slide_width = Emu(int(w / 150 * 914400))
        prs.slide_height = Emu(int(h / 150 * 914400))
        for p in pages:
            slide = prs.slides.add_slide(prs.slide_layouts[6])
            slide.shapes.add_picture(os.path.join(tmp, p), 0, 0, prs.slide_width, prs.slide_height)
        prs.save(dst)


if __name__ == '__main__':
    kind, src, dst = sys.argv[1:4]
    {'word': to_word, 'excel': to_excel, 'ppt': to_ppt}[kind](src, dst)
