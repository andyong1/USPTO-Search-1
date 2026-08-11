# OCR the FRONT pages of staged reexam OPPOSITION documents. What the paper
# opposes is stated in the caption on page 1 and usually restated in the opening
# paragraph, so 6 pages is ample -- the remainder is argument. Idempotent: skips
# any PDF that already has a .txt sibling, so it can be re-run while the
# downloader is still fetching.
#
#     cat petopp-ocr.py | python -                # default dir: petopp-prod
#     cat petopp-ocr.py | python - petopp-prod    # explicit
#
# Dependencies: pip install pymupdf pillow winocr   (Windows built-in OCR)

import sys
from pathlib import Path

import fitz  # PyMuPDF

WORK = Path("snq-cumulative") / (sys.argv[1] if len(sys.argv) > 1 else "petopp-prod")
PDF_DIR = WORK / "pdf"
DPI = 200
FRONT_PAGES = 6
MAX_CHARS = 30000


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
    print(f"OCR: {len(todo)} of {len(pdfs)} oppositions (front {FRONT_PAGES}pp each).")
    zoom = DPI / 72
    done = 0
    for p in todo:
        try:
            doc = fitz.open(p)
            pages = []
            for i, pg in enumerate(list(doc)[:FRONT_PAGES]):
                pix = pg.get_pixmap(matrix=fitz.Matrix(zoom, zoom))
                pages.append(f"[page {i + 1}]\n" + _ocr_page_windows(pix))
            txt = "\n".join(pages).strip()[:MAX_CHARS]
            (WORK / (p.stem + ".txt")).write_text(txt if txt else "(no text extracted)", encoding="utf-8")
            done += 1
            if done % 25 == 0:
                print(f"  …{done}/{len(todo)}")
        except Exception as e:  # noqa: BLE001 -- report and continue
            print(f"  {p.stem}: OCR failed ({e})")
    print(f"OCR'd {done}/{len(todo)} PDF(s) this run.")


main()
