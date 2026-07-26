# Nightly AI pass — reexam request-vs-NIRC prior-art comparison

For each concluded ex parte reexam that ended in a NIRC (Notice of Intent to
Issue a Reexam Certificate), compare the prior art the **requester relied on**
(as recited in the reexam ORDER's SNQs) against the art the examiner actually
**discussed in the NIRC** — labeling each NIRC reference by the role it played —
so the /reexam-nirc page can report how often the request's art is operative at
conclusion. Text staged by `nirc-fetch.mjs`; results uploaded by
`nirc-upload.mjs`. The percentage statistic is computed in code from your
structured lists — your job is accurate extraction + matching, not the math.

## Procedure

1. `node nirc-fetch.mjs` (POSTGRES_URL already in env). If it reports nothing, stop.
2. `cat preorder-ocr.py | python - nirc-work 20` (OCRs any image-only NIRC PDFs;
   NIRCs run long — the reasons statement sits behind the PTOL-469 cover form —
   so this OCRs up to 20 pages, not the 3 the petition passes use).
3. Read `snq-cumulative/nirc-work/manifest.json`. Each entry has `application_number`,
   `nirc_date`, `outcome_summary` (the claim disposition), `order_file`, `nirc_file`.
4. For each entry read BOTH `snq-cumulative/nirc-work/<order_file>` and `<nirc_file>`.
5. Append one JSON line per proceeding to `snq-cumulative/nirc-work/nirc-out.jsonl`:

```json
{"application_number":"90014123","req_refs":[{"label":"Aoyama (US 7,123,456)","key":"US7123456"}],"nirc_refs":[{"label":"Aoyama","key":"US7123456","role":"invalidating"}],"matches":[{"label":"Aoyama","key":"US7123456","role":"invalidating"}],"basis":"reasons-stated","confidence":"high","note":""}
```

6. `node nirc-upload.mjs` — validates and stores; computes the overlap counts.

## What to extract

- **`req_refs`** — the prior-art references underlying the **substantial new
  questions of patentability (SNQs)** as recited in the ORDER (the art the
  requester built its grounds on, whether or not every SNQ was adopted). Do NOT
  harvest background/IDS citations or the challenged patent itself — only the
  art the order identifies as the basis of the reexamination request/SNQs.
- **`nirc_refs`** — every prior-art reference the NIRC's *Statement of Reasons
  for Patentability and/or Confirmation* (or equivalent reasons discussion)
  actually discusses, each tagged with `role`:
  - `invalidating` — the reference was the basis for **canceling/rejecting** a
    challenged claim (art that "won").
  - `distinguished` — the reference is the **closest art the confirmed claims
    were distinguished over** (art the claims survived).
  - `mentioned` — named but neither the basis of cancellation nor the closest
    distinguished art (e.g. listed in passing, or cumulative).
- **`matches`** — the subset of `req_refs` that appears in `nirc_refs`, each with
  the role it played in the NIRC. This is the operative overlap. A request
  reference the NIRC never discusses is NOT a match.

## Reference identity & keys

- `key` = a normalized identifier for matching across the two documents:
  - Patent/publication number → digits only, prefixed by country if non-US
    (`US7123456`, `US20050123456A1` → `US20050123456`, `EP1234567`). Strip
    kind codes and commas.
  - No number available (NPL, or a reference named only by inventor) → the
    first-named author/inventor surname lowercased (`aoyama`), plus a short
    year if given (`aoyama2005`).
- Two references match when their keys refer to the same document. Judge by the
  number when present; fall back to inventor surname + context. Account for OCR
  noise (a transposed digit, `l`/`1`, `O`/`0`) — if the surrounding name/title
  makes identity clear, treat as the same reference and note it.
- `label` = a short human-readable form (inventor name and/or number) for the page.

## basis (drives whether the row counts in the statistic)

- `reasons-stated` — the NIRC gives a substantive reasons statement naming art.
- `as-amended` — claims were confirmed **as amended** and the NIRC discusses art
  distinguished by the amended claims (still counts; note it).
- `not-stated` — the NIRC gives NO art-based reasons (e.g. "confirmed for the
  reasons in the final Office action", or purely procedural). `nirc_refs` and
  `matches` empty. These are EXCLUDED from the operative-art percentage.
- `no-nirc-art` — a reasons statement exists but cites no prior art. Empty
  `nirc_refs`/`matches`.

## Hard rules

- Extract only from the two provided documents. No outside knowledge of the
  patents or references.
- A reference in `matches` MUST also appear in both `req_refs` and `nirc_refs`
  with a consistent key. Never invent a reference or a number.
- Do not infer a role the NIRC text doesn't support — use `mentioned` when the
  role is unclear, and `not-stated` when there is no reasons discussion at all.
- If the order text is missing/garbled so you cannot establish `req_refs`, set
  `confidence":"low"` and note it (still extract `nirc_refs` if the NIRC is
  readable). If the NIRC text is missing/garbled, set `basis":"not-stated"`,
  empty NIRC arrays, `confidence":"low"`, and note it.
- `note` ≤200 chars. One line per manifest entry — no skips, no extras, no line
  breaks in values.
