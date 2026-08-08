# AI pass — relief AS FILED (from the petition document)

For each reexam **PETITION**, extract the relief the petitioner actually asked
for, read from the petition itself. Text staged by `petreq-fetch.mjs` +
`petreq-ocr.py`; results uploaded by `petreq-upload.mjs`.

This is deliberately **not** the same task as `petsubj-verify.md`:

| | petsubj (decision) | **petreq (this pass)** |
|---|---|---|
| Source | the Office's decision | the petitioner's own paper |
| Question | how the Office **characterized** the request | what the petitioner **asked for** |
| Outcome | yes (`merits_outcome`) | **none — a petition has no disposition** |

Its two jobs: supply relief for petitions with **no decision yet** (most rows on
/reexam-petition-decisions), and act as an independent cross-check where a
decision does exist. Disagreement between the two is a real finding, not an
error — do not try to make them match.

## Procedure
1. `node petreq-fetch.mjs` (POSTGRES_URL + USPTO_API_KEY in env). If it reports 0
   needing extraction, stop.
2. `cat petreq-ocr.py | python -` (front 10 pages).
3. Read `snq-cumulative/petreq-prod/manifest.json` (each entry: `application_number`,
   `doc_id`, `petition_date`, `file`).
4. Read each `snq-cumulative/petreq-prod/<file>`.
5. Append one JSON line per petition to `snq-cumulative/petreq-prod/petreq-out.jsonl`.
6. `node petreq-upload.mjs`.

## Where the relief is stated

Usually twice, both within the front pages:
- **The caption / title**, e.g. *"PETITION UNDER 37 C.F.R. § 1.181 TO VACATE THE
  ORDER GRANTING REEXAMINATION"* — often the single best evidence.
- An **introduction or "Relief Requested" section**, e.g. *"Patent Owner
  respectfully requests that the Director … terminate this proceeding under 35
  U.S.C. § 325(d)."*

A combined petition asks for several things at once (very common here): a 1.183
waiver of 1.515(a)/1.530(a)/1.540 **so that** a § 325(d) request can be reached.
List them all; pick the substantive one as primary.

## Controlled relief vocabulary (use these exact strings)

`extension_of_time` · `vacate_or_terminate_proceeding` · `reconsider_snq_or_order` ·
`withdraw_finality` · `waiver_or_suspension_of_rule` · `matters_not_provided_for` ·
`supervisory_review` · `expunge_or_strike_paper` · `concurrent_proceedings_or_stay` ·
`interview_request` · `entry_of_papers_or_amendment` ·
`filing_date_or_fee_or_defective_request` · `revival_or_abandonment` ·
`correct_certificate_or_inventorship` · `withdraw_as_attorney` · `other`

Same vocabulary as the decision pass, so the two are directly comparable. If a
request has no entry (e.g. a plea for expedited consideration), use `other` and
say what it was in `note`.

## Output line

```json
{"doc_id":"MRZ9NTMR120X224","application_number":"90016339","reliefs":["waiver_or_suspension_of_rule","vacate_or_terminate_proceeding"],"primary_relief":"vacate_or_terminate_proceeding","rules":["37 CFR 1.183","37 CFR 1.540"],"statutes":["35 USC 325(d)"],"petitioner":"patent_owner","relief_verbatim":"requests waiver of 37 CFR 1.540 so the Office may consider its request to deny reexamination","confidence":"high","note":""}
```

- `primary_relief` = the ultimate substantive ask (NOT the procedural waiver,
  unless the waiver is genuinely all that was requested).
- `relief_verbatim` = ≤25-word quote from the petition showing the ask — prefer
  the caption when it states the relief.
- `petitioner`: `patent_owner` | `third_party_requester` | `unclear`. The signature
  block and the "Patent Owner"/"Requester" self-designation both help.
- `confidence`: `high` (caption or an explicit relief section states it) ·
  `medium` (inferred from the argument) · `low` (OCR poor / front pages don't
  reach the ask).
- `note` ≤200 chars, no line breaks. **No outcome field** — do not report or guess
  a disposition even if the petition predicts one.

## Hard rules

- Read ONLY the petition text provided. Never infer relief from the document code
  or the file name.
- A petition may be a **requester opposition** mis-filed under a petition code; if
  the paper is plainly an opposition to someone else's petition rather than a
  request for relief, set `reliefs` to `["other"]`, `confidence` `low`, and say so.
- Front pages sometimes open with a certificate of service or table of contents —
  keep reading to the caption/introduction.
- If the OCR never reaches a statement of relief, use `confidence: "low"` with a
  note rather than guessing.
