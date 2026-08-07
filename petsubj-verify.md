# AI pass — petition subject matter (relief requested + merits disposition)

For each reexam petition **DECISION**, extract what relief the petition asked for
and how the Office resolved the **substantive** ask. Text staged by
`petsubj-fetch.mjs` + `petsubj-ocr.py`; results uploaded by `petsubj-upload.mjs`.
Feeds the relief filter and the merits-based statistics on
/reexam-petition-decisions.

## Procedure
1. `node petsubj-fetch.mjs` (POSTGRES_URL + USPTO_API_KEY in env). If it reports
   0 needing classification, stop.
2. `cat petsubj-ocr.py | python -` (OCR, 25-page cap).
3. Read `snq-cumulative/petsubj-prod/manifest.json` (each entry: `application_number`,
   `doc_id`, `decision_date`, `doc_code`, `file`).
4. Read each `snq-cumulative/petsubj-prod/<file>`.
5. Append one JSON line per decision to `snq-cumulative/petsubj-prod/petsubj-out.jsonl`.
6. `node petsubj-upload.mjs`.

## The central rule: merits, not the vehicle

These decisions routinely dispose of **several requests at once**. The dominant
pattern is a patent owner filing a combined petition where a **37 CFR 1.183
waiver** (of 1.515(a)/1.530(a)/1.540) is granted *so that* the Office can reach a
**§ 325(d) request to terminate the reexamination**, which is then **dismissed**.

Granting the waiver is a procedural courtesy, **not** a win on the merits.
So:
- **`primary_relief`** = the ultimate substantive relief the petitioner wanted
  (here: `vacate_or_terminate_proceeding`), NOT the waiver.
- **`merits_outcome`** = the disposition of that substantive relief (here:
  `dismissed`).
- **`ancillary_waiver`** = the disposition of the procedural waiver leg
  (`granted`), or `null` when there is no separate waiver leg.
- **`reliefs`** = EVERY relief requested, including the waiver (multi-label).

If a petition's *only* ask is the waiver (nothing further requested), then
`primary_relief` is `waiver_or_suspension_of_rule` and `merits_outcome` is that
waiver's disposition. Likewise, procedural vehicles (`supervisory_review`,
`matters_not_provided_for`) are the primary relief only when nothing more
substantive is sought through them.

If the decision expressly defers the substantive request to the CRU / another
decision-maker without deciding it, set `merits_outcome` to `undecided`.

## Controlled relief vocabulary (use these exact strings)

`extension_of_time` · `vacate_or_terminate_proceeding` · `reconsider_snq_or_order` ·
`withdraw_finality` · `waiver_or_suspension_of_rule` · `matters_not_provided_for` ·
`supervisory_review` · `expunge_or_strike_paper` · `concurrent_proceedings_or_stay` ·
`interview_request` · `entry_of_papers_or_amendment` ·
`filing_date_or_fee_or_defective_request` · `revival_or_abandonment` ·
`correct_certificate_or_inventorship` · `withdraw_as_attorney` · `other`

## Output line

```json
{"doc_id":"MQISZDP5X20X206","application_number":"90015457","reliefs":["waiver_or_suspension_of_rule","vacate_or_terminate_proceeding"],"primary_relief":"vacate_or_terminate_proceeding","merits_outcome":"dismissed","ancillary_waiver":"granted","rules":["37 CFR 1.181","37 CFR 1.183","37 CFR 1.540"],"statutes":["35 USC 325(d)"],"petitioner":"patent_owner","relief_verbatim":"requests the Office terminate the present reexamination proceeding","confidence":"high","note":""}
```

- `merits_outcome`: `granted` | `granted_in_part` | `dismissed` | `denied` | `undecided` | `other`
- `ancillary_waiver`: `granted` | `dismissed` | `denied` | omit/null if none
- `petitioner`: `patent_owner` | `third_party_requester` | `unclear`
- `relief_verbatim`: ≤25-word quote showing what was requested (the evidence)
- `rules` / `statutes`: as cited, normalized (`37 CFR 1.183`, `35 USC 325(d)`); `[]` if none
- `confidence`: `high` (relief and disposition both explicit) · `medium` (one inferred)
  · `low` (OCR poor / conclusion missing — see the OCR caveat below)
- `note` ≤200 chars, no line breaks

## Hard rules / known traps

- **OCR can invert meaning.** One validated sample read "the Office will waive
  37 CFR 1.530(a)" in the body where the conclusion said "will **not** waive."
  **Always anchor the disposition on the decision's CONCLUSION/ORDER section**,
  not mid-document prose. If body and conclusion conflict, follow the conclusion
  and say so in `note`.
- If the OCR is truncated before any conclusion, set `merits_outcome` to `other`
  and `confidence` to `low` with a note — do not guess.
- Never read the disposition from the file name or the document code; the code is
  an independent cross-check maintained elsewhere.
- Page 1 is usually a PTOL-90A cover sheet — substance starts on page 2 (though a
  few decisions start on page 1).
- Some decisions are checkbox forms (PTO-2293); the requested relief may only
  appear on attached summary pages.
- Multiple reliefs → list them all in `reliefs`, but pick exactly one
  `primary_relief`.
