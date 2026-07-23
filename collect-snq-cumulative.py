#!/usr/bin/env python3
"""
Collect ex parte reexamination (90/*) DETERMINATIONS (orders RXREXO + denials
RXREXD) and PETITION DECISIONS dated on/after 2025-01-01, extract their text
(text layer first, OCR fallback for scanned ones), and surface every passage
that discusses a reference being "cumulative" in the substantial-new-question-
of-patentability (SNQ) context.

Fully local. PDFs are fetched through your site's /api/document proxy, which
already holds the USPTO API key and resolves the real download URLs, so no key
is needed here.

REQUIRES:   pip install requests pdfminer.six
OPTIONAL (OCR for scanned / image-only decisions):
            pip install pytesseract pdf2image pillow
            + install the Tesseract OCR engine and Poppler and put them on PATH.
            Without these, image-only decisions are downloaded and flagged in the
            report (text_source = "none") so you can OCR them separately.

RUN:        python collect-snq-cumulative.py
RESUMABLE:  re-run any time. Downloaded PDFs and extracted .txt are cached, so a
            second run only fetches/extracts what's new (and can finish OCR once
            you've installed Tesseract).

ENV OVERRIDES:
  SITE_BASE       default https://andy-ong.com
  OUT_DIR         default ./snq-cumulative
  SINCE           default 2025-01-01  (official-date floor, YYYY-MM-DD)
  CONTEXT_CHARS   default 600         (chars of context kept around each hit)
  MAX_PROCEEDINGS default 0 (no limit; set a small number to test)
  SNQ_INSECURE=1  disable TLS verification (ONLY if a corporate MITM proxy breaks
                  cert validation; downloads are public USPTO records)
"""

import csv
import os
import re
import sys
import time
from pathlib import Path

try:
    import requests
except ImportError:
    sys.exit("Missing dependency: pip install requests pdfminer.six")

try:
    from pdfminer.high_level import extract_text as pdf_extract_text
except ImportError:
    sys.exit("Missing dependency: pip install pdfminer.six")

BASE = os.environ.get("SITE_BASE", "https://andy-ong.com").rstrip("/")
OUT = Path(os.environ.get("OUT_DIR", "./snq-cumulative"))
SINCE = os.environ.get("SINCE", "2025-01-01")
CONTEXT = int(os.environ.get("CONTEXT_CHARS", "600"))
MAX_PROCEEDINGS = int(os.environ.get("MAX_PROCEEDINGS", "0"))
_verify = os.environ.get("SNQ_INSECURE") != "1"  # flips to False automatically on a TLS error
_ssl_warned = False
if not _verify:
    import urllib3
    urllib3.disable_warnings()


def http_get(url, timeout):
    """GET with a one-time automatic fallback to verify=False on a TLS error.
    Corporate MITM proxies often break certificate validation; these downloads
    are public USPTO records fetched via your own site, so this is acceptable."""
    global _verify, _ssl_warned
    try:
        return requests.get(url, timeout=timeout, verify=_verify)
    except requests.exceptions.SSLError:
        if not _verify:
            raise
        _verify = False
        if not _ssl_warned:
            print("  [warn] TLS verification failed (corporate proxy?) — continuing without it.")
            _ssl_warned = True
        import urllib3
        urllib3.disable_warnings()
        return requests.get(url, timeout=timeout, verify=False)

# SNQ context markers — used to tag whether a "cumulative" hit sits in an
# SNQ discussion. Deliberately broad (we keep all hits; this is just a flag).
SNQ_MARKERS = re.compile(
    r"substantial new question|\bSNQ\b|\bSNQP\b|§?\s*303\b|1\.515|1\.552|1\.510|patentab",
    re.I,
)
PETITION_DECISION_CODES = {"RXPTGR", "RXPTDI"}
OCR_MARK = "%%OCR%%\n"  # first-line sentinel in cached .txt to note OCR-sourced text


def ymd(raw):
    m = re.search(r"(\d{4})-?(\d{2})-?(\d{2})", str(raw or ""))
    return f"{m.group(1)}-{m.group(2)}-{m.group(3)}" if m else ""


def san(s):
    return re.sub(r"[^0-9A-Za-z._-]", "_", str(s or ""))


def get_json(path, tries=4):
    url = BASE + path
    for i in range(tries):
        try:
            r = http_get(url, 60)
            if r.status_code == 200:
                return r.json()
            if r.status_code in (429, 500, 502, 503, 504):
                time.sleep(1.5 * (i + 1))
                continue
            return None
        except requests.RequestException:
            time.sleep(1.5 * (i + 1))
    return None


def is_petition_decision(code, desc):
    c = (code or "").upper()
    d = (desc or "").lower()
    if c in PETITION_DECISION_CODES or c.startswith("RXPT"):
        return True
    if "petition" in d and any(w in d for w in ("decision", "dismiss", "grant", "denied", "denial")):
        return True
    return False


def list_determinations():
    """Determination decisions (orders/denials) since SINCE, from /api/reexam."""
    data = get_json("/api/reexam") or {}
    out = []
    for d in data.get("determinations", []):
        date = ymd(d.get("official_date"))
        if not date or date < SINCE:
            continue
        doc = d.get("document_identifier")
        app = d.get("application_number")
        if not (doc and app):
            continue
        denied = "denied" in str(d.get("determination_type", "")).lower()
        out.append({
            "app": app, "doc": doc, "date": date,
            "category": "denial" if denied else "order",
            "code": "RXREXD" if denied else "RXREXO",
            "desc": d.get("determination_type", ""),
        })
    return out


def list_petition_decisions(app):
    """Petition decisions for one proceeding, since SINCE, via the documents proxy."""
    data = get_json(f"/api/application?appNum={app}&section=documents")
    if not data:
        return []
    bag = data.get("documentBag") or data.get("documents") or (data if isinstance(data, list) else [])
    out = []
    for d in bag:
        code = d.get("documentCode") or ""
        desc = d.get("documentCodeDescriptionText") or d.get("documentDescriptionText") or ""
        if not is_petition_decision(code, desc):
            continue
        date = ymd(d.get("officialDate") or d.get("officialDateTime") or d.get("mailRoomDate"))
        if not date or date < SINCE:
            continue
        doc = d.get("documentIdentifier") or d.get("documentId")
        if not doc:
            continue
        out.append({"app": app, "doc": doc, "date": date, "category": "petition-decision",
                    "code": (code or "").upper(), "desc": desc})
    return out


def download(app, doc, dest: Path):
    if dest.exists() and dest.stat().st_size > 0:
        return True
    url = f"{BASE}/api/document?appNum={app}&documentId={doc}&format=PDF&disposition=attachment"
    try:
        r = http_get(url, 120)
    except requests.RequestException:
        return False
    if r.status_code != 200 or r.content[:5] != b"%PDF-":
        return False
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(r.content)
    return True


def ocr_pdf(path: Path):
    # Uses the pytesseract + pdf2image wrappers (already importable) plus the
    # Tesseract and Poppler binaries. If those aren't on PATH, point at them with
    # the TESSERACT_CMD and POPPLER_PATH env vars (no PATH edit / admin needed).
    try:
        import pytesseract
        from pdf2image import convert_from_path
    except Exception:
        return None
    tcmd = os.environ.get("TESSERACT_CMD")
    if tcmd:
        pytesseract.pytesseract.tesseract_cmd = tcmd
    poppler = os.environ.get("POPPLER_PATH") or None
    try:
        pages = convert_from_path(str(path), dpi=300, poppler_path=poppler)
        return "\n".join(pytesseract.image_to_string(p) for p in pages)
    except Exception:
        return None


def get_text(pdf: Path, txt: Path):
    """Return (text, source). Cache to .txt. source in {textlayer, ocr, none}."""
    if txt.exists():
        cached = txt.read_text(encoding="utf-8", errors="ignore")
        if cached.startswith(OCR_MARK):
            return cached[len(OCR_MARK):], "ocr"
        return cached, "textlayer"
    text = ""
    try:
        text = pdf_extract_text(str(pdf)) or ""
    except Exception:
        text = ""
    if len(re.sub(r"\s", "", text)) >= 100:
        txt.write_text(text, encoding="utf-8")
        return text, "textlayer"
    # Sparse/no text layer → try OCR.
    ocr = ocr_pdf(pdf)
    if ocr and len(re.sub(r"\s", "", ocr)) >= 100:
        txt.write_text(OCR_MARK + ocr, encoding="utf-8")
        return ocr, "ocr"
    return text, "none"


def find_cumulative(text):
    hits = []
    for m in re.finditer(r"cumulative", text, re.I):
        s, e = max(0, m.start() - CONTEXT), min(len(text), m.end() + CONTEXT)
        window = re.sub(r"\s+", " ", text[s:e]).strip()
        hits.append({"snq": bool(SNQ_MARKERS.search(text[s:e])), "snippet": window})
    return hits


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    text_dir = OUT / "text"
    text_dir.mkdir(exist_ok=True)

    print(f"Site: {BASE}   Since: {SINCE}   Out: {OUT.resolve()}")
    print("Enumerating determinations (orders + denials)…")
    dets = list_determinations()
    apps = sorted({d["app"] for d in dets})
    if MAX_PROCEEDINGS:
        apps = apps[:MAX_PROCEEDINGS]
        dets = [d for d in dets if d["app"] in set(apps)]
    print(f"  {len(dets)} determinations across {len(apps)} proceedings.")

    print("Enumerating petition decisions per proceeding (one API call each)…")
    pet = []
    for i, app in enumerate(apps, 1):
        pet.extend(list_petition_decisions(app))
        if i % 25 == 0:
            print(f"  …{i}/{len(apps)} proceedings scanned")
        time.sleep(0.25)  # be gentle on the proxy / USPTO
    print(f"  {len(pet)} petition decisions found.")

    docs = dets + pet
    # Dedup by (app, doc).
    seen, uniq = set(), []
    for d in docs:
        k = (d["app"], d["doc"])
        if k not in seen:
            seen.add(k)
            uniq.append(d)
    print(f"Total unique documents to process: {len(uniq)}")

    subdir = {"order": "determinations", "denial": "determinations", "petition-decision": "petition-decisions"}
    report_rows, match_blocks = [], []
    need_ocr = 0

    for i, d in enumerate(uniq, 1):
        name = f"{san(d['app'])}_{san(d['category'])}_{d['date']}_{san(d['doc'])}"
        pdf = OUT / subdir[d["category"]] / (name + ".pdf")
        txt = text_dir / (name + ".txt")
        ok = download(d["app"], d["doc"], pdf)
        if not ok:
            report_rows.append([d["app"], d["category"], d["code"], d["date"], "DOWNLOAD_FAILED", "", 0, 0, ""])
            continue
        text, src = get_text(pdf, txt)
        if src == "none":
            need_ocr += 1
        hits = find_cumulative(text)
        snq_hits = [h for h in hits if h["snq"]]
        report_rows.append([
            d["app"], d["category"], d["code"], d["date"], "ok", src,
            len(hits), len(snq_hits), str(pdf),
        ])
        if snq_hits:
            block = [f"## {d['app']} — {d['category']} ({d['code']}) — {d['date']}",
                     f"[{d['app']} on the site]({BASE}/uspto-search?app={d['app']})  ·  source: {src}", ""]
            for h in snq_hits:
                block.append(f"> …{h['snippet']}…\n")
            match_blocks.append("\n".join(block))
        if i % 20 == 0:
            print(f"  processed {i}/{len(uniq)}")

    # Write report.csv
    with (OUT / "report.csv").open("w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["control_no", "category", "doc_code", "date", "status",
                    "text_source", "cumulative_hits", "snq_context_hits", "pdf_path"])
        w.writerows(report_rows)

    # Write matches.md (the passages with SNQ context, for review / synthesis)
    with (OUT / "matches.md").open("w", encoding="utf-8") as f:
        f.write(f"# 'Cumulative' in the SNQ context — reexam decisions since {SINCE}\n\n")
        f.write(f"Documents scanned: {len(uniq)} · with an SNQ-context 'cumulative' passage: {len(match_blocks)}\n\n")
        f.write("\n---\n\n".join(match_blocks) if match_blocks else "_No matching passages found._\n")

    docs_with_snq = sum(1 for r in report_rows if r[7])
    print("\nDone.")
    print(f"  report.csv  — {len(report_rows)} documents")
    print(f"  matches.md  — {docs_with_snq} documents with a 'cumulative'+SNQ passage")
    if need_ocr:
        print(f"  NOTE: {need_ocr} document(s) had no text layer and OCR was unavailable")
        print("        (install pytesseract+pdf2image+Tesseract+Poppler, then re-run to OCR them).")


if __name__ == "__main__":
    main()
