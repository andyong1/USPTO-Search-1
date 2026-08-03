# Nightly AI pass — third-party requester identity (from the reexam request)

For third-party ex parte reexaminations, the request document (doc code
RXOSUB.R*) authoritatively names the requester in its opening — e.g. *"Pursuant
to 37 C.F.R. 1.510, **Caterpillar Inc.** ('Requester') submits this request …
assigned to Doosan Bobcat North America, Inc. ('Patent Owner')"*, or *"…
**ORBCOMM Inc.** ('Requester') requests an ex parte reexamination …"*. This pass
reads the front pages and extracts that requester. Text staged by
`reqid-fetch.mjs`; results uploaded by `reqid-upload.mjs`. The /reexam Requester
column shows the name.

## Procedure

1. `node reqid-fetch.mjs --limit N` (POSTGRES_URL already in env). If it reports
   "Nothing to analyze.", stop.
2. `cat preorder-ocr.py | python - reqid-work 8 14000` (OCR the image-only request
   front pages — same DLP caveat as the other OCR steps).
3. Read `snq-cumulative/reqid-work/manifest.json` (each entry: `application_number`,
   `req_code`, `req_date`, `req_file`).
4. Read each `snq-cumulative/reqid-work/<req_file>` (the request's front-page text).
5. Append one JSON line per proceeding to
   `snq-cumulative/reqid-work/reqid-out.jsonl`:

```json
{"application_number":"90016001","requester_name":"Caterpillar Inc.","confidence":"high","note":""}
```

6. `node reqid-upload.mjs` — validates and stores into `reexam_requester`.

## What to extract

- **`requester_name`** — the entity that submits/requests the reexamination: the
  party explicitly designated **("Requester")**, or the subject of "X submits/
  requests this request for ex parte reexamination". This is the **real party in
  interest** (the company/individual), e.g. "Caterpillar Inc.", "ORBCOMM Inc.",
  "Unified Patents, LLC", "Samsung Electronics America, Inc." Clean obvious OCR
  noise (e.g. "Sam ung" → "Samsung"); keep the legal suffix (Inc./LLC/Ltd.).

## Hard rules

- The requester comes ONLY from the staged request text.
- **Do NOT return the attorney / law firm / counsel** (e.g. "Sterne, Kessler,
  Goldstein & Fox", "Skadden, Arps…"), the **patent owner**, or the USPTO. If the
  opening names only counsel and never the client/requester, return empty
  `requester_name` with `confidence":"low"` and a short note.
- If the text is missing ("(no text extracted)"), garbled, or you cannot
  confidently identify the requester, return empty `requester_name`,
  `confidence":"low"`, and a short note (the row stays "—" until re-run).
- `requester_name` ≤120 chars, `note` ≤200 chars; one JSON line per manifest
  entry; no line breaks in values.
