# Nightly AI residual related-litigation pass

For petitions whose "Related Matters" the regex extractor left EMPTY, read the
stored front-matter and extract any U.S. district-court litigation on the
challenged patent that the regex missed (unusual prose formats). This is a
RESIDUAL pass — these are the hard cases, so be **precision-biased**: it is far
better to return nothing than to invent a court. Runs in the scheduled Claude
session; text staged by `lit-fetch.mjs`, results uploaded by `lit-upload.mjs`.

## Procedure

1. `node lit-fetch.mjs` (POSTGRES_URL already in env). If it reports nothing, stop.
2. Read `snq-cumulative/lit-work/manifest.json` — each entry has `trial_number`,
   `petitioner_name`, and `po_name` (the patent owner). Then read each
   `snq-cumulative/lit-work/<trial_number>.txt` (a ~9–23 KB front-matter window
   that contains the Related Matters section).
3. For each, append one JSON line to `snq-cumulative/lit-work/lit-out.jsonl`:

```json
{"trial_number":"IPR2024-00123","petitioner":["E.D. Tex."],"other":["D. Del."],"note":""}
```

4. `node lit-upload.mjs` — validates and uploads.

## What to extract

District courts named for litigation on the **challenged patent**, as Bluebook
reporter shorthands, split into two columns:

- **`petitioner`** — districts of cases where the IPR **petitioner** (see
  `petitioner_name`) is a party (usually the district-court defendant the patent
  owner sued).
- **`other`** — districts of cases on the same patent against a **different**
  party (not the petitioner).

Both are arrays of shorthands, e.g. `["E.D. Tex."]`, `["D. Del.", "N.D. Cal."]`.
Use the canonical form the site uses: `D. Del.`, `E.D. Tex.`, `W.D. Tex.`,
`N.D. Cal.`, `C.D. Cal.`, `S.D.N.Y.`, `E.D.N.Y.`, `D.N.J.`, `N.D. Ill.`,
`D. Mass.`, `E.D. Va.`, `N.D. Ga.`, `D. Colo.`, `W.D. Wash.`, `D. Del.`, etc.
(direction + `D.` + state abbreviation). A district may appear in BOTH columns
if there are separate cases.

## Hard rules (precision first)

- Only count litigation where the **patent owner** (`po_name`) is a party — they
  assert the patent (as plaintiff) or are the DJ defendant. A court mentioned in
  a claim-construction / Fintiv / §314(a) *authority citation* (some other case
  cited for law) is NOT related litigation — ignore it.
- Only the **Related Matters / related litigation** disclosure. Do not harvest
  courts from the prior-art discussion or string cites.
- **Never infer a district from a case number alone.** "2:24-cv-01070" does NOT
  tell you the district ("2:24" is a division/judge code, not a court). If a case
  is listed with only a number/caption and no district is named, leave it out and
  set `note` to e.g. "cases listed without a district".
- **ITC investigations (337-TA-####), PTAB/IPR/PGR proceedings, and foreign
  cases are NOT district-court litigation** — do not put them in the arrays; note
  them if that's all there is (e.g. "ITC only", "foreign litigation only").
- If there is genuinely no related district-court litigation disclosed, return
  empty arrays with a short `note` ("no related litigation disclosed", "case
  number only", "ITC only", "foreign only", etc.).
- `note`: ≤160 chars; "" when both arrays are populated and unambiguous.
- Base everything ONLY on the document text. No outside knowledge of the patent,
  parties, or where a case number maps. No prose in the arrays; no line breaks.
