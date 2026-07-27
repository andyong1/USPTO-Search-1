# Nightly AI pass — related litigation from the RXLITSR search report

Each reexamination has an examiner "Litigation Search Report" (document code
RXLITSR, "Reexam Litigation Search Conducted") that records the district-court
litigation found for the patent. This pass reads that report and extracts the
related cases. Text staged by `rxlit-fetch.mjs`; results uploaded by
`rxlit-upload.mjs`. The `Related Litigation` column on /reexam renders your
structured list; you are not computing any statistic.

## Procedure

1. `node rxlit-fetch.mjs --limit N` (POSTGRES_URL already in env). If it reports
   "Nothing to analyze.", stop.
2. `cat preorder-ocr.py | python - rxlit-work 12 20000` (OCR the image-only
   reports; they are short — same DLP caveat as the other OCR steps).
3. Read `snq-cumulative/rxlit-work/manifest.json`. Each entry has
   `application_number`, `litsr_date`, `court_hints` (court-context snippets from
   the determination text — use ONLY to attach a court to a docket you already
   read in the report), and `litsr_file`.
4. Read each `snq-cumulative/rxlit-work/<litsr_file>` (the search-report text).
5. Append one JSON line per proceeding to
   `snq-cumulative/rxlit-work/rxlit-out.jsonl`:

```json
{"application_number":"90016001","cases":[{"caption":"Doosan Bobcat North America, Inc. v. Caterpillar, Inc. et al.","case_no":"2:25-cv-01184","court":"E.D. Tex.","status":"open"}],"none_found":false,"confidence":"high","note":""}
```

For a report that says NO LITIGATION WAS FOUND:

```json
{"application_number":"96050104","cases":[],"none_found":true,"confidence":"high","note":""}
```

6. `node rxlit-upload.mjs` — validates and stores into `reexam_litigation`.

## What to extract

- **`cases`** — one object per distinct district-court case the report lists:
  - **`caption`** — the party caption as written ("X v. Y" / "X v. Y et al."),
    verbatim from the report, lightly cleaned of OCR noise. No docket number in
    the caption.
  - **`case_no`** — the docket number, normalized to `D:YY-cv-NNNNN` when the
    report gives one (e.g. `2:24cv49` → `2:24-cv-00049`; keep as-is if you cannot
    confidently normalize). Empty string if the report gives no docket number.
  - **`court`** — the district shorthand (`E.D. Tex.`, `D. Del.`, `W.D. Tex.`,
    `N.D. Cal.`, …). Take it from the report if named; otherwise, if the SAME
    docket number appears in `court_hints`, use the court spelled out there.
    Empty string if neither names the court.
  - **`status`** — `open`, `closed`, or `unknown`, from the report's
    OPEN/CLOSED/status markings (the report often prints "(OPEN)" or a status
    column). Use `unknown` when the report does not say.
- **`none_found`** — `true` only when the report affirmatively states no
  litigation was found (e.g. "NO LITIGATION WAS FOUND"). Otherwise `false`.

## Hard rules

- Cases come ONLY from the staged report text. `court_hints` may fill a `court`
  for a docket you already read in the report — never add a case that appears
  only in the hints.
- **Never infer a district from a bare docket number.** If neither the report
  nor a matching hint names the court, leave `court` empty.
- Exclude PTAB/IPR/reexam proceedings, ITC investigations, and foreign matters —
  district-court civil actions only.
- Deduplicate: one entry per case even if the report lists it more than once.
- If the report text is missing/garbled/truncated so you cannot read the cases,
  output empty `cases` with `none_found":false`, `confidence":"low"`, and a short
  note (the row stays "—" until re-run).
- `caption` ≤160 chars, `note` ≤200 chars; one JSON line per manifest entry; no
  line breaks in values.
