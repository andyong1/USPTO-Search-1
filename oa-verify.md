# Nightly AI pass — final-Office-action art (the "see final office action" bucket)

For NIRCs whose statement of reasons named no prior art (they cancelled claims
for failure to respond, or deferred their reasons to the final Office action),
the operative art lives in the last substantial Office action. This pass reads
that action and extracts the art that was actually operative, matching it
against the request art already extracted from the order. Text staged by
`oa-fetch.mjs`; results uploaded by `oa-upload.mjs`. As with the NIRC pass, the
percentages are computed in code from your structured lists.

## Procedure

1. `node oa-fetch.mjs` (POSTGRES_URL already in env). If it reports nothing, stop.
2. `cat preorder-ocr.py | python - oa-work 60 200000` (OCR the actions in full;
   they run long — same DLP caveat as the other OCR steps).
3. Read `snq-cumulative/oa-work/manifest.json`. Each entry has `application_number`,
   `oa_code` (RXFR.. final rejection | RXR.NF non-final), `oa_date`, `req_refs`
   (the request's art, already extracted from the order — match against THIS),
   and `oa_file`.
4. Read each `snq-cumulative/oa-work/<oa_file>` (the Office action text).
5. Append one JSON line per proceeding to `snq-cumulative/oa-work/oa-out.jsonl`:

```json
{"application_number":"90015426","oa_refs":[{"label":"Smith (US 7,123,456)","key":"us7123456","role":"invalidating"}],"matches":[{"label":"Smith","key":"us7123456","role":"invalidating"}],"confidence":"high","note":""}
```

6. `node oa-upload.mjs` — validates and stores (flips the row's source to the
   final Office action).

## What to extract

- **`oa_refs`** — every prior-art reference the Office action's rejections /
  reasons actually turn on, each tagged `role`:
  - `invalidating` — the reference is the basis of an **adopted rejection** of a
    challenged claim (the action rejects the claim over it). For a
    failure-to-respond cancellation, the art in the final rejection that stood
    is `invalidating`.
  - `distinguished` — the reference is the closest art the action **confirms /
    indicates allowable** claims over (a "reasons for confirmation/allowability"
    section, if any).
  - `mentioned` — named but neither.
- **`matches`** — the subset of the manifest's `req_refs` that appears in
  `oa_refs`, each with the role it played. Match on the normalized `key`
  (patent-number digits with country prefix, else inventor surname), tolerating
  OCR noise as in the NIRC spec. A request reference the action never turns on
  is NOT a match.

## Hard rules

- `oa_refs`/`matches` come ONLY from the staged Office action text; `req_refs`
  come ONLY from the manifest. Never invent a reference or a number.
- A `matches` entry MUST appear in both the manifest `req_refs` and your
  `oa_refs` with a consistent key.
- If the action text is missing/garbled/truncated so you cannot identify the
  operative art, output empty `oa_refs`/`matches` with `confidence":"low"` and a
  short note (the row simply stays without a final-OA match).
- Keep roles faithful to the action: a claim rejected over a reference →
  `invalidating`; a claim confirmed over it → `distinguished`.
- `note` ≤200 chars; one line per manifest entry; no line breaks in values.
