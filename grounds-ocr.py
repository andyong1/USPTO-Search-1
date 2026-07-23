# OCR the determination documents of reexaminations that have a prior/parallel
# PTAB proceeding (the set we compare for §325(d) / overlapping art), into
# snq-cumulative/text/<name>.txt. Cross-platform OCR: Apple Vision on macOS, the
# Windows built-in engine on Windows.
#
# Determination PDFs are DOWNLOADED ON DEMAND from the site (using the document
# IDs from /api/reexam), so this always covers the CURRENT pipeline — including
# determinations issued after any earlier local download. Re-running tops up only
# the new ones (existing text files are skipped).
#
# Run from the uspto-search folder (invoke via `cat grounds-ocr.py | python -` on
# the locked-down Windows box):
#     python grounds-ocr.py            # pipeline reexams (prior/parallel PTAB), resumable
#     python grounds-ocr.py --all      # every reexam determination (large)
#     python grounds-ocr.py --limit 5  # small test run
#     python grounds-ocr.py --pdf <appNum>-<docId>.pdf   # OCR a hand-downloaded
#                                       # PDF when the on-demand download 502s
#
# Output per determination: a .txt (pages separated by \f) + a .json sidecar
# {pages, chars, engine}. Filenames match what grounds-upload.mjs expects:
#     <controlNumber>_<order|denial|determination>_<YYYY-MM-DD>_<docId>.txt
#
# Dependencies:  pip install pymupdf   (+ macOS: pyobjc-framework-Vision  |  Windows: pillow winocr)

import json
import ssl
import sys
import time
import urllib.request
from pathlib import Path

import fitz  # PyMuPDF

SITE = "https://andy-ong.com"
TXT_DIR = Path("snq-cumulative/text")
DPI = 200
IS_MAC = sys.platform == "darwin"
ENGINE = "vision" if IS_MAC else "winocr"

# Python 3.13+ enables strict X.509 checks that reject a corporate TLS-inspection
# proxy's cert (no Authority Key Identifier). Keep verification on; drop only the
# strict-extension flag. Harmless off-proxy.
_CTX = ssl.create_default_context()
_CTX.verify_flags &= ~ssl.VERIFY_X509_STRICT

def _get(url, binary=False):
    req = urllib.request.Request(url, headers={"User-Agent": "grounds-ocr"})
    with urllib.request.urlopen(req, timeout=60, context=_CTX) as r:
        return r.read() if binary else json.load(r)

def pipeline_app_numbers():
    data = _get(f"{SITE}/api/ptab?compare=1")
    norm = lambda s: "".join(c for c in str(s or "") if c.isalnum())
    return {norm(l.get("appNum")) for l in data.get("links", []) if l.get("appNum")}

def determinations():
    data = _get(f"{SITE}/api/reexam")
    return data.get("determinations") or data.get("rows") or []


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

def ocr_pdf_bytes(buf):
    doc = fitz.open(stream=buf, filetype="pdf")
    layer = [pg.get_text() for pg in doc]
    if sum(len(t.strip()) for t in layer) > 100 * len(doc):
        return "\f".join(layer), len(doc), "textlayer"
    zoom = DPI / 72
    pages = []
    for pg in doc:
        pix = pg.get_pixmap(matrix=fitz.Matrix(zoom, zoom))
        pages.append(_ocr_page(pix))
    return "\f".join(pages), len(doc), ENGINE


def kind_of(t):
    t = str(t or "").lower()
    return "order" if "order" in t else "denial" if "deni" in t else "determination"

def ocr_local(pdf_path):
    # Escape hatch for when the on-demand document download 502s: OCR a PDF the
    # user downloaded by hand. Name the file <appNum>-<docId>.pdf (the same
    # convention as manual Patent Center downloads); kind/date are looked up from
    # /api/reexam so the output filename matches what grounds-upload.mjs expects.
    TXT_DIR.mkdir(parents=True, exist_ok=True)
    p = Path(pdf_path)
    app, _, doc = p.stem.partition("-")
    app = "".join(c for c in app if c.isalnum())
    if not app or not doc:
        print(f"  filename must be <appNum>-<docId>.pdf, got: {p.name}")
        return
    meta = next((d for d in determinations() if d.get("document_identifier") == doc), None)
    kind = kind_of(meta.get("determination_type")) if meta else "determination"
    date = str(meta.get("official_date") or "")[:10] if meta else ""
    date = date or "nodate"
    buf = p.read_bytes()
    if buf[:5] != b"%PDF-":
        print(f"  not a PDF: {p.name}")
        return
    text, npages, engine = ocr_pdf_bytes(buf)
    name = f"{app}_{kind}_{date}_{doc}"
    (TXT_DIR / f"{name}.txt").write_text(text, encoding="utf-8")
    (TXT_DIR / f"{name}.json").write_text(json.dumps({"pages": npages, "chars": len(text), "engine": engine}))
    print(f"OCR'd {p.name} -> {name}.txt  ({npages} pages, {len(text)} chars, {engine})")

def main():
    if "--pdf" in sys.argv:
        return ocr_local(sys.argv[sys.argv.index("--pdf") + 1])
    limit = int(sys.argv[sys.argv.index("--limit") + 1]) if "--limit" in sys.argv else None
    TXT_DIR.mkdir(parents=True, exist_ok=True)
    # Existing text files (by doc id in the filename) are skipped — resumable.
    done_docs = {f.stem.split("_")[-1] for f in TXT_DIR.glob("*.txt")}

    dets = determinations()
    if "--all" not in sys.argv:
        apps = pipeline_app_numbers()
        print(f"{len(apps)} reexams with prior/parallel PTAB proceedings")
        dets = [d for d in dets if "".join(c for c in str(d.get("application_number") or "") if c.isalnum()) in apps]
    if "--since" in sys.argv:  # e.g. --since 2026-01-01 (official_date lower bound)
        since = sys.argv[sys.argv.index("--since") + 1]
        dets = [d for d in dets if str(d.get("official_date") or "")[:10] >= since]
    todo = [d for d in dets if d.get("document_identifier") and d["document_identifier"] not in done_docs]
    if limit:
        todo = todo[:limit]
    print(f"{len(dets)} pipeline determinations in scope, {len(todo)} to OCR  (engine: {ENGINE})")

    t0 = time.time()
    ok = fail = 0
    for i, d in enumerate(todo, 1):
        app = "".join(c for c in str(d["application_number"]) if c.isalnum())
        doc = d["document_identifier"]
        date = str(d.get("official_date") or "")[:10] or "nodate"
        name = f"{app}_{kind_of(d.get('determination_type'))}_{date}_{doc}"
        try:
            buf = _get(f"{SITE}/api/document?appNum={app}&documentId={doc}&format=PDF&disposition=attachment", binary=True)
            if buf[:5] != b"%PDF-":
                raise RuntimeError("not a PDF (error page?)")
            text, npages, engine = ocr_pdf_bytes(buf)
            (TXT_DIR / f"{name}.txt").write_text(text, encoding="utf-8")
            (TXT_DIR / f"{name}.json").write_text(json.dumps({"pages": npages, "chars": len(text), "engine": engine}))
            ok += 1
        except Exception as e:
            fail += 1
            print(f"  FAIL {app}/{doc}: {type(e).__name__}: {str(e)[:90]}")
        if i % 20 == 0 or i == len(todo):
            per_min = i / ((time.time() - t0) / 60)
            print(f"  {i}/{len(todo)} ({per_min:.1f}/min, eta {(len(todo)-i)/per_min if per_min else 0:.0f} min)")
    print(f"Done. {ok} OCR'd, {fail} failed (re-run to retry).")

if __name__ == "__main__":
    main()
