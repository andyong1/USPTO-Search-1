# OCR the staged petition DECISIONS (validation batch). Decisions are short, so
# OCR up to MAX_PAGES pages in full — the relief-sought recital is usually on
# page 1-2 and the disposition at the end, so we want the whole document.
# Idempotent: skips any PDF that already has a .txt sibling.
#
#     cat petsubj-ocr.py | python -                # default dir: petsubj-prod
#     cat petsubj-ocr.py | python - petsubj-work   # a different work folder

import sys
from pathlib import Path

import fitz  # PyMuPDF

WORK = Path("snq-cumulative") / (sys.argv[1] if len(sys.argv) > 1 else "petsubj-prod")
PDF_DIR = WORK / "pdf"
DPI = 200
MAX_PAGES = 25
MAX_CHARS = 90000


def _ocr_page_windows(pix):
    import asyncio
    from PIL import Image
    import winocr
    img = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
    result = asyncio.run(winocr.recognize_pil(img, "en"))
    return "\n".join(l.text for l in result.lines)


def main():
    pdfs = sorted(PDF_DIR.glob("*.pdf"))
    todo = [p for p in pdfs if not (WORK / (p.stem + ".txt")).exists()]
    if not todo:
        print(f"Nothing to OCR ({len(pdfs)} PDFs all have .txt).")
        return
    print(f"OCR: {len(todo)} of {len(pdfs)} decision PDFs (up to {MAX_PAGES}pp each).")
    zoom = DPI / 72
    done = 0
    for p in todo:
        try:
            doc = fitz.open(p)
            pages = []
            for i, pg in enumerate(list(doc)[:MAX_PAGES]):
                pix = pg.get_pixmap(matrix=fitz.Matrix(zoom, zoom))
                pages.append(f"[page {i + 1}]\n" + _ocr_page_windows(pix))
            txt = "\n".join(pages).strip()[:MAX_CHARS]
            (WORK / (p.stem + ".txt")).write_text(txt if txt else "(no text extracted)", encoding="utf-8")
            done += 1
            print(f"  {p.stem}: {len(txt)} chars")
        except Exception as e:  # noqa: BLE001
            print(f"  {p.stem}: OCR failed ({e})")
    print(f"OCR'd {done}/{len(todo)} PDF(s).")


main()
