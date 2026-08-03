# Idempotent front-page OCR for the requester rescan (option A). OCRs the first
# FRONT_PAGES pages of every snq-cumulative/reqid-rescan/pdf/*.pdf that does NOT
# already have a sibling <stem>.txt, so it can be run repeatedly / while the
# downloader is still fetching (each run picks up newly-arrived PDFs). Windows
# built-in OCR (winocr), same engine as preorder-ocr.py.
#
#     cat reqid-rescan-ocr.py | python -

from pathlib import Path

import fitz  # PyMuPDF

WORK = Path("snq-cumulative") / "reqid-rescan"
PDF_DIR = WORK / "pdf"
DPI = 200
FRONT_PAGES = 20
MAX_CHARS = 40000


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
    print(f"OCR: {len(todo)} of {len(pdfs)} PDFs need text (front {FRONT_PAGES}pp each).")
    zoom = DPI / 72
    done = 0
    for p in todo:
        try:
            doc = fitz.open(p)
            pages = []
            for pg in list(doc)[:FRONT_PAGES]:
                pix = pg.get_pixmap(matrix=fitz.Matrix(zoom, zoom))
                pages.append(_ocr_page_windows(pix))
            txt = "\f".join(pages).strip()[:MAX_CHARS]
            (WORK / (p.stem + ".txt")).write_text(txt if txt else "(no text extracted)", encoding="utf-8")
            done += 1
            if done % 20 == 0:
                print(f"  …{done}/{len(todo)}")
        except Exception as e:  # noqa: BLE001
            print(f"  {p.stem}: OCR failed ({e})")
    print(f"OCR'd {done}/{len(todo)} PDF(s) this run.")


main()
