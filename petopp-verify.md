# AI pass — what an OPPOSITION opposes

For each reexam **OPPOSITION**, read what paper it answers and who filed it.
Text staged by `petopp-fetch.mjs` + `petopp-ocr.py`; results uploaded by
`petopp-upload.mjs`.

## Why this pass exists

Oppositions used to be paired to petitions by filing order, and that guessed
wrong. In 90/015,704 a paper opposing a **patent owner filing that the Office
never entered into the wrapper** was attached to an unrelated third-party
requester petition, so the page reported that the requester's petition had drawn
an opposition. It had not.

A timing window now catches the obvious cases, but a window is still a guess.
An opposition *states* its target in the caption, so reading it replaces the
guess with evidence — including the finding that the opposed paper **is not in
our data at all**, which is the single most useful thing this pass produces.

## Procedure
1. `node petopp-fetch.mjs` (POSTGRES_URL + USPTO_API_KEY in env). If it reports 0
   needing extraction, stop.
2. `cat petopp-ocr.py | python -` (front 6 pages).
3. Read `snq-cumulative/petopp-prod/manifest.json` (each entry:
   `application_number`, `doc_id`, `opposition_date`, `file`).
4. Read each `snq-cumulative/petopp-prod/<file>`.
5. Append one JSON line per opposition to
   `snq-cumulative/petopp-prod/petopp-out.jsonl`.
6. `node petopp-upload.mjs`.

## Where the target is stated

Almost always in the caption, occasionally only in the opening sentence:

- *"THIRD PARTY REQUESTER'S OPPOSITION TO PATENT OWNER'S PETITION FILED
  MARCH 30, 2026"* → `opposes_date` = `2026-03-30`
- *"Patent Owner's Opposition to the Petition under 37 C.F.R. § 1.181 filed
  February 23, 2026"* → `opposes_date` = `2026-02-23`
- *"Opposition to Petition"* with no date anywhere → `opposes_date` = `null`

Report the date **as the paper states it**, converted to `YYYY-MM-DD`. Do not
adjust it to match any petition you may know of, and do not go looking for one:
a date that matches nothing in the wrapper is a correct and valuable answer.

## Output line

```json
{"doc_id":"MO96MNFAX138X73","application_number":"90015704","party":"third_party_requester","opposes_date":"2026-03-30","opposes_verbatim":"Requester's Opposition to Patent Owner's Petition filed March 30, 2026","confidence":"high","note":""}
```

- `party`: `patent_owner` | `third_party_requester` | `unclear` — who FILED the
  opposition. The signature block and the self-designation in the caption both
  help. This matters on its own: nobody opposes their own petition, so the filing
  party alone can rule a pairing out.
- `opposes_date`: `YYYY-MM-DD` of the paper opposed, or `null` if not stated.
  **Never infer it from the opposition's own filing date.**
- `opposes_verbatim`: ≤25-word quote naming the paper opposed.
- `confidence`: `high` (caption names the paper and its date) · `medium` (target
  named but undated, or date only in the body) · `low` (OCR poor, or the front
  pages never identify what is opposed).
- `note` ≤200 chars, no line breaks.

## Hard rules

- Read ONLY the text provided. Never infer the target from the document code, the
  file name, or the `nearest_petition_date` in the manifest — that field is
  context for a human, and it is precisely the guess this pass exists to check.
- **An unmatched date is a result, not a failure.** If the opposition names a
  paper we have no record of, report the date it states. That is how a paper the
  Office never entered gets identified.
- Not everything filed under an opposition code is an opposition. If the paper is
  actually a petition, an exhibit, a certificate of service, or an Office paper,
  set `"is_opposition": false`, `confidence` `low`, and begin `note` with
  `Not an opposition:`.
- If the front pages never say what is opposed, use `confidence: "low"` with a
  note rather than guessing a date.
