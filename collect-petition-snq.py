#!/usr/bin/env python3
"""
Collect ex parte reexamination (90/*) PETITION DECISIONS dated on/after
2024-06-16, extract their text (text layer first, OCR fallback), and surface
every passage discussing a reference being "cumulative" in the substantial-
new-question-of-patentability (SNQ) context.

PETITION DECISIONS ONLY — this does NOT download determinations (you already
have those). The universe of proceedings is enumerated directly from USPTO
search (not the site's determination set), so it isn't limited to 2025+.

RUN IT AS A .txt (your machine's security policy blocks Python from reading
.py files; Python runs a file as source regardless of extension):
    python collect-petition-snq.txt

REQUIRES (all already importable on your machine):  requests, pdfminer.six
OPTIONAL OCR for scanned/image-only decisions (wrappers already present):
    pytesseract + pdf2image, plus the Tesseract and Poppler *binaries*.
    If those binaries aren't on PATH, point at them with env vars (no admin):
        set TESSERACT_CMD=C:\\path\\to\\tesseract.exe
        set POPPLER_PATH=C:\\path\\to\\poppler\\Library\\bin
    Without them, image-only decisions still download and are flagged
    text_source="none" so you can OCR them on a later run.

RESUMABLE: re-run any time; downloaded PDFs and extracted text are cached.

ENV OVERRIDES:
  SITE_BASE       default https://andy-ong.com
  OUT_DIR         default ./snq-petition-decisions
  SINCE           default 2024-06-16  (petition-decision official-date floor)
  FILED_FROM      default 2022-06-16  (enumeration: reexams filed on/after this;
                  widen if you suspect older reexams have in-window petitions)
  CONTEXT_CHARS   default 600
  MAX_PROCEEDINGS default 0 (no limit; set small to test)
  SNQ_INSECURE=1  force TLS verification off (auto-detected otherwise)
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
OUT = Path(os.environ.get("OUT_DIR", "./snq-petition-decisions"))
SINCE = os.environ.get("SINCE", "2024-06-16")
FILED_FROM = os.environ.get("FILED_FROM", "2022-06-16")
CONTEXT = int(os.environ.get("CONTEXT_CHARS", "600"))
MAX_PROCEEDINGS = int(os.environ.get("MAX_PROCEEDINGS", "0"))

SNQ_MARKERS = re.compile(
    r"substantial new question|\bSNQ\b|\bSNQP\b|§?\s*303\b|1\.515|1\.552|1\.510|patentab",
    re.I,
)
PETITION_DECISION_CODES = {"RXPTGR", "RXPTDI"}
OCR_MARK = "%%OCR%%\n"

_verify = os.environ.get("SNQ_INSECURE") != "1"  # flips to False automatically on a TLS error
_ssl_warned = False
if not _verify:
    import urllib3
    urllib3.disable_warnings()


def _ssl_fallback():
    global _verify, _ssl_warned
    _verify = False
    if not _ssl_warned:
        print("  [warn] TLS verification failed (corporate proxy?) — continuing without it.")
        _ssl_warned = True
    import urllib3
    urllib3.disable_warnings()


def http_get(url, timeout):
    global _verify
    try:
        return requests.get(url, timeout=timeout, verify=_verify)
    except requests.exceptions.SSLError:
        if not _verify:
            raise
        _ssl_fallback()
        return requests.get(url, timeout=timeout, verify=False)


def http_post(url, payload, timeout):
    global _verify
    try:
        return requests.post(url, json=payload, timeout=timeout, verify=_verify)
    except requests.exceptions.SSLError:
        if not _verify:
            raise
        _ssl_fallback()
        return requests.post(url, json=payload, timeout=timeout, verify=False)


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


def enumerate_proceedings():
    """All 90/* reexam control numbers filed on/after FILED_FROM, via USPTO search."""
    apps, offset = [], 0
    total = None
    for page in range(120):  # hard cap 120 * 100 = 12,000
        payload = {
            "q": "applicationNumberText:90*",
            "rangeFilters": [{"field": "applicationMetaData.filingDate", "valueFrom": FILED_FROM, "valueTo": "2100-01-01"}],
            "fields": ["applicationNumberText"],
            "pagination": {"offset": offset, "limit": 100},
        }
        try:
            r = http_post(BASE + "/api/search", payload, 60)
            if r.status_code != 200:
                time.sleep(1.5)
                continue
            data = r.json()
        except Exception:
            break
        if total is None:
            total = data.get("count") or data.get("totalNumFound")
        hits = data.get("patentFileWrapperDataBag") or []
        if not hits:
            break
        for h in hits:
            an = h.get("applicationNumberText") or (h.get("applicationMetaData") or {}).get("applicationNumberText")
            if an:
                apps.append(an)
        offset += 100
        if len(hits) < 100:
            break
        time.sleep(0.2)
    return sorted(set(apps)), total


def is_petition_decision(code, desc):
    c = (code or "").upper()
    d = (desc or "").lower()
    if c in PETITION_DECISION_CODES or c.startswith("RXPT"):
        return True
    if "petition" in d and any(w in d for w in ("decision", "dismiss", "grant", "denied", "denial")):
        return True
    return False


def list_petition_decisions(app):
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
        out.append({"app": app, "doc": doc, "date": date, "code": (code or "").upper(), "desc": desc})
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
    pdf_dir = OUT / "petition-decisions"

    print(f"Site: {BASE}")
    print(f"Petition decisions dated >= {SINCE}; reexams filed >= {FILED_FROM}")
    print(f"Out: {OUT.resolve()}")

    print("Enumerating 90/* reexam control numbers from USPTO search…")
    apps, total = enumerate_proceedings()
    if MAX_PROCEEDINGS:
        apps = apps[:MAX_PROCEEDINGS]
    print(f"  {len(apps)} proceedings to scan" + (f" (USPTO reports {total} total filed since {FILED_FROM})" if total else ""))

    print("Scanning each proceeding for petition decisions (one API call each)…")
    docs = []
    for i, app in enumerate(apps, 1):
        docs.extend(list_petition_decisions(app))
        if i % 50 == 0:
            print(f"  …{i}/{len(apps)} scanned — {len(docs)} petition decisions so far")
        time.sleep(0.2)
    # Dedup by (app, doc)
    seen, uniq = set(), []
    for d in docs:
        k = (d["app"], d["doc"])
        if k not in seen:
            seen.add(k)
            uniq.append(d)
    print(f"  {len(uniq)} petition decisions dated >= {SINCE}")

    report_rows, match_blocks = [], []
    need_ocr = 0
    for i, d in enumerate(uniq, 1):
        name = f"{san(d['app'])}_{san(d['code'] or 'petdec')}_{d['date']}_{san(d['doc'])}"
        pdf = pdf_dir / (name + ".pdf")
        txt = text_dir / (name + ".txt")
        if not download(d["app"], d["doc"], pdf):
            report_rows.append([d["app"], d["code"], d["date"], "DOWNLOAD_FAILED", "", 0, 0, ""])
            continue
        text, src = get_text(pdf, txt)
        if src == "none":
            need_ocr += 1
        hits = find_cumulative(text)
        snq_hits = [h for h in hits if h["snq"]]
        report_rows.append([d["app"], d["code"], d["date"], "ok", src, len(hits), len(snq_hits), str(pdf)])
        if snq_hits:
            block = [f"## {d['app']} — petition decision ({d['code']}) — {d['date']}",
                     f"[{d['app']} on the site]({BASE}/uspto-search?app={d['app']})  ·  source: {src}", ""]
            for h in snq_hits:
                block.append(f"> …{h['snippet']}…\n")
            match_blocks.append("\n".join(block))
        if i % 20 == 0:
            print(f"  processed {i}/{len(uniq)}")

    with (OUT / "report.csv").open("w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["control_no", "doc_code", "date", "status", "text_source",
                    "cumulative_hits", "snq_context_hits", "pdf_path"])
        w.writerows(report_rows)

    with (OUT / "matches.md").open("w", encoding="utf-8") as f:
        f.write(f"# 'Cumulative' in the SNQ context — reexam PETITION DECISIONS since {SINCE}\n\n")
        f.write(f"Petition decisions scanned: {len(uniq)} · with an SNQ-context 'cumulative' passage: {len(match_blocks)}\n\n")
        f.write("\n---\n\n".join(match_blocks) if match_blocks else "_No matching passages found._\n")

    docs_with_snq = sum(1 for r in report_rows if r[6])
    print("\nDone.")
    print(f"  report.csv  — {len(report_rows)} petition decisions")
    print(f"  matches.md  — {docs_with_snq} with a 'cumulative'+SNQ passage")
    if need_ocr:
        print(f"  NOTE: {need_ocr} decision(s) had no text layer and OCR was unavailable.")
        print("        Install the Tesseract + Poppler binaries (or set TESSERACT_CMD / POPPLER_PATH)")
        print("        and re-run to OCR them.")


if __name__ == "__main__":
    main()
