# Nightly AI verification of reexam certificate claim outcomes

Read the OCR text of each ex parte reexamination certificate (RXCERT) or Notice
of Intent to Issue a Reexam Certificate (NIRC) and extract the exact claim
disposition. This is more accurate than the regex parser on scanned/garbled
certificate OCR. Runs inside the scheduled Claude session; text is staged by
`cert-fetch.mjs` and results uploaded by `cert-upload.mjs`.

## Procedure

1. `node cert-fetch.mjs` (POSTGRES_URL already in env). If it reports nothing to
   verify, stop.
2. Read `snq-cumulative/cert-work/manifest.json`, then each
   `snq-cumulative/cert-work/<application_number>.txt`.
3. For each certificate, append one JSON line to
   `snq-cumulative/cert-work/cert-out.jsonl`:

```json
{"application_number":"90014689","confirmed":"1-5, 7","cancelled":"6","amended":"8-10","new":"11-15","confidence":"high","note":""}
```

4. `node cert-upload.mjs` — validates, composes the summary, and uploads.

## Fields

For each of the four dispositions, output the claim list **exactly as the
certificate states it**, normalized to comma/space/hyphen form (e.g.
`"1-5, 7, 9-12"`). Use `""` when that disposition has no claims.

- **`confirmed`** — claims confirmed / patentability confirmed (unchanged, held
  patentable as-is).
- **`cancelled`** — claims cancelled (held unpatentable / disclaimed).
- **`amended`** — claims "determined to be patentable as amended," plus claims
  held patentable *because they depend on an amended claim*.
- **`new`** — newly added claims determined patentable ("New claims X are added
  and determined to be patentable").

Then:

- **`confidence`** — `"high"` (text clear, disposition unambiguous), `"medium"`
  (OCR noise but the disposition is recoverable with confidence), or `"low"`
  (garbled/partial — the claim numbers may be wrong; the reader should verify).
- **`note`** — short optional string (≤160 chars) only when useful: e.g. "cancellation clause OCR-garbled", "certificate confirms all original claims", or a caveat. Empty string otherwise.

## Rules

- **Read ONLY the disposition/holding of THIS certificate.** Do not infer from
  the claim bodies or outside knowledge. The control/application number in the
  file name is the proceeding; if the text is clearly a *different* patent's
  certificate filed as an exhibit, set every list to `""`, confidence `"low"`,
  and note "certificate appears to be for a different proceeding".
- Two layouts occur: **prose** ("Claims 1-5 are confirmed. Claim 6 is
  cancelled.") and **PTOL-465 form** ("patent claim(s) confirmed: 1-20" with a
  blank field meaning none). Handle both; a blank form field means that
  category is empty, not unknown.
- OCR routinely misreads commas as periods, "1" as "I"/"l", and interleaves
  two-column text. Reconstruct the intended claim list; if a specific number is
  unrecoverable, drop it and lower confidence + note it rather than guessing.
- Distinguish carefully: **confirmed ≠ amended**. "Patentable as amended" is
  `amended`, not `confirmed`. Claims merely *rejected then confirmed on the
  merits* without amendment are `confirmed`.
- A certificate always disposes of claims — if you cannot extract ANY
  disposition, set all four to `""`, confidence `"low"`, and note why.
- Claim lists only: digits, commas, hyphens, "and" is fine but prefer commas.
  No prose inside the four list fields. No line breaks anywhere in the JSON.
