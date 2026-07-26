# Nightly AI pass — fill the NIRC claim disposition (Outcome column)

For NIRCs whose certificate hasn't issued yet, the /reexam-nirc Outcome column
is blank. The disposition is stated on the NIRC's PTOL-469 cover form. Read it
and produce a concise outcome. Text staged by `ocfill-fetch.mjs`; uploaded by
`ocfill-upload.mjs`.

## Procedure

1. `node ocfill-fetch.mjs` (POSTGRES_URL in env). If nothing, stop.
2. `cat preorder-ocr.py | python - oc-work 4 8000` (OCR the cover pages).
3. Read `snq-cumulative/oc-work/manifest.json` (application_number, file) and each
   `snq-cumulative/oc-work/<file>`.
4. Append one JSON line per proceeding to `snq-cumulative/oc-work/oc-out.jsonl`:

```json
{"application_number":"90015426","confirmed":"","cancelled":"1-11","amended":"","new":"","summary":"All claims (1-11) cancelled"}
```

5. `node ocfill-upload.mjs`.

## What to read (PTOL-469 cover form)

The form lists the disposition in numbered lines, e.g.:
- "Patent claim(s) confirmed: 1-26" → `confirmed`
- "Patent claim(s) cancelled: 1-11" → `cancelled`
- "Patent claim(s) amended: ..." → `amended`
- "Newly presented claim(s) patentable: 27-30" → `new`

Fields (claim-number ranges exactly as printed, e.g. "1-5, 9"; "" if that
category is empty):
- `confirmed`, `cancelled`, `amended`, `new`
- `summary` — a short human-readable disposition, ≤80 chars. Examples:
  - all confirmed → "All claims (1-26) confirmed"
  - all cancelled → "All claims (1-11) cancelled"
  - mixed → "Claims 1-5 confirmed; 6-10 cancelled; 11-12 added"
  - amended → "Claims 1-8 confirmed as amended"
  Always include the words "confirmed"/"cancelled"/"amended" as applicable so
  the page can color the badge.

## Hard rules

- Read ONLY the staged cover-form text; do not infer from outside knowledge.
- If the text is a cover-only stub with no disposition, or is unreadable, output
  all empty fields and `summary":""` (the row simply stays blank).
- Cancellations for failure to respond still read as "cancelled" on the form —
  report them as cancelled.
- One line per manifest entry; no line breaks in values.
