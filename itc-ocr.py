# OCR the scanned dispositive PDFs saved by itc-ocr-fetch.mjs to
# itc-work/ocr-work/pdf/, writing itc-work/ocr-work/<docId>.txt for itc-ocr-upload.mjs.
# Same cross-platform OCR engine as preorder-ocr.py (Apple Vision on macOS, the
# Windows built-in engine on Windows). Dispositive docs (opinions/IDs/orders/
# notices) — OCR up to PAGES pages so the holding/order is captured.
#
# Run from the uspto-search folder:
#     cat itc-ocr.py | python -              # 30 pages, 120k chars (defaults)
#     cat itc-ocr.py | python - 50 200000    # more pages/chars

import sys
from pathlib import Path

import fitz  # PyMuPDF

WORK = Path("itc-work") / "ocr-work"
PDF_DIR = WORK / "pdf"
DPI = 200
PAGES = int(sys.argv[1]) if len(sys.argv) > 1 else 30
MAX_CHARS = int(sys.argv[2]) if len(sys.argv) > 2 else 120000
IS_MAC = sys.platform == "darwin"


def _ocr_page_mac(pix):
    import Vision
    from Foundation import NSData
    png = pix.tobytes("png")
    data = NSData.dataWithBytes_length_(png, len(png))
    handler = Vision.VNImageRequestHandler.alloc().initWithData_options_(data, None)
    req = Vision.VNRecognizeTextRequest.alloc().init()
    req.setRecognitionLevel_(Vision.VNRequestTextRecognitionLevelAccurate)
    req.setUsesLanguageCorrection_(True)
    req.setRecognitionLanguages_(["en-US"])
    handler.performRequests_error_([req], None)
    obs = req.results() or []
    def order(o):
        bb = o.boundingBox()
        return (round(-bb.origin.y, 2), round(bb.origin.x, 2))
    lines = []
    for o in sorted(obs, key=order):
        cand = o.topCandidates_(1)
        if cand:
            lines.append(cand[0].string())
    return "\n".join(lines)


def _ocr_page_windows(pix):
    import asyncio
    from PIL import Image
    import winocr
    img = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
    result = asyncio.run(winocr.recognize_pil(img, "en"))
    return "\n".join(l.text for l in result.lines)


_ocr_page = _ocr_page_mac if IS_MAC else _ocr_page_windows


def main():
    if not PDF_DIR.is_dir():
        print("No PDFs to OCR.")
        return
    pdfs = sorted(PDF_DIR.glob("*.pdf"))
    if not pdfs:
        print("No PDFs to OCR.")
        return
    done = 0
    for p in pdfs:
        out = WORK / (p.stem + ".txt")
        if out.is_file():
            done += 1
            continue  # resume: skip already-OCR'd
        try:
            doc = fitz.open(p)
            zoom = DPI / 72
            pages = []
            for pg in list(doc)[:PAGES]:
                pix = pg.get_pixmap(matrix=fitz.Matrix(zoom, zoom))
                pages.append(_ocr_page(pix))
            txt = "\f".join(pages).strip()[:MAX_CHARS]
            out.write_text(txt if txt else "(no text extracted)", encoding="utf-8")
            done += 1
            print(f"  {p.stem}: {len(txt)} chars ({min(len(list(doc)), PAGES)} pages)", flush=True)
        except Exception as e:  # noqa: BLE001
            print(f"  {p.stem}: OCR failed ({e})", flush=True)
    print(f"OCR'd {done}/{len(pdfs)} PDF(s).")


main()
