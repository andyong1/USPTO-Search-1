# OCR the image-only pre-order candidate documents that preorder-fetch.mjs
# saved to snq-cumulative/preorder-work/pdf/ (PDFs with no text layer), and
# overwrite the matching .txt work files so the AI pass can read them.
# Same cross-platform OCR as grounds-ocr.py: Apple Vision on macOS, the Windows
# built-in engine (winocr) on Windows. Only the first PAGES pages are OCR'd —
# captions/openings are what decide petition attribution.
#
# Run from the uspto-search folder (via `cat preorder-ocr.py | python -` on the
# locked-down Windows box), after preorder-fetch.mjs and before the AI pass.
#
# Dependencies:  pip install pymupdf   (+ macOS: pyobjc-framework-Vision  |  Windows: pillow winocr)

import json
import sys
from pathlib import Path

import fitz  # PyMuPDF

WORK = Path("snq-cumulative/preorder-work")
PDF_DIR = WORK / "pdf"
DPI = 200
PAGES = 3
MAX_CHARS = 12000
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
        print("No image-only PDFs to OCR.")
        return
    pdfs = sorted(PDF_DIR.glob("*.pdf"))
    if not pdfs:
        print("No image-only PDFs to OCR.")
        return
    done = 0
    chars_by_file = {}
    for p in pdfs:
        try:
            doc = fitz.open(p)
            zoom = DPI / 72
            pages = []
            for pg in list(doc)[:PAGES]:
                pix = pg.get_pixmap(matrix=fitz.Matrix(zoom, zoom))
                pages.append(_ocr_page(pix))
            txt = "\f".join(pages).strip()[:MAX_CHARS]
            out = WORK / (p.stem + ".txt")
            out.write_text(txt if txt else "(no text extracted)", encoding="utf-8")
            chars_by_file[out.name] = len(txt)
            done += 1
            print(f"  {p.stem}: {len(txt)} chars")
        except Exception as e:  # noqa: BLE001 — report and continue
            print(f"  {p.stem}: OCR failed ({e})")
    # Refresh the manifest's char counts so the AI sees which files are readable.
    mf = WORK / "manifest.json"
    if mf.is_file():
        manifest = json.loads(mf.read_text(encoding="utf-8"))
        for entry in manifest:
            for c in entry.get("candidates", []):
                if c.get("file") in chars_by_file:
                    c["chars"] = chars_by_file[c["file"]]
        mf.write_text(json.dumps(manifest, indent=1), encoding="utf-8")
    print(f"OCR'd {done}/{len(pdfs)} PDF(s).")


main()
