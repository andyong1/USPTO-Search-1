# Nightly AI pass — post-order § 325(d) petition attribution

The /reexam-petitions page tracks, per ordered reexam: the **patent owner's
petition** citing 35 U.S.C. § 325(d) asking the Office to reconsider/vacate/
terminate the reexam order, the **third-party requester's opposition**, and the
Office's **decision on that petition**. The document codes are party- and
purpose-agnostic (`PET.OP`/`RXPET.` cover both parties and any relief;
several petitions may be pending and decided the same day), so the timing
heuristic can flag the wrong paper or the decision on a different petition.
Your job: read the candidates' opening pages and SELECT the correct three
documents. Text staged by `postpet-fetch.mjs`, results uploaded by
`postpet-upload.mjs`.

## Procedure

1. `node postpet-fetch.mjs` (POSTGRES_URL already in env). If it reports
   nothing, stop.
2. `cat preorder-ocr.py | python - postpet-work` (OCRs any image-only PDFs the
   fetch saved under pdf/).
3. Read `snq-cumulative/postpet-work/manifest.json`. Each entry has:
   - `order_date` — when the reexam was ordered,
   - `flagged` — the timing heuristic's current picks (incl. its keyword-regex
     325(d) determinations),
   - `candidates[]` — every candidate: `doc_id`, `code`, `date`, `desc`,
     `kind` (petition-paper | opposition | decision), `file`, `chars`.
4. Read each candidate's `snq-cumulative/postpet-work/<file>` (opening pages).
5. Append one JSON line per proceeding to
   `snq-cumulative/postpet-work/postpet-out.jsonl`:

```json
{"application_number":"90015000","pet_doc_id":"...","pet_325d":true,"opp_doc_id":"...","dec_doc_id":"...","dec_outcome":"dismissed","dec_325d":true,"confidence":"high","note":""}
```

6. `node postpet-upload.mjs` — validates against the manifest and uploads.

## How to judge

- **`pet_doc_id`** — the `petition-paper` candidate actually filed by the
  **patent owner** petitioning the Office to reconsider, vacate, or terminate
  the reexamination order (37 CFR 1.181/1.182/1.183; typically argues the
  request presented the same or substantially the same art/arguments under
  § 325(d)). Judge the filer and relief from the caption, opening paragraph,
  and signature block. Requester papers, PO petitions for unrelated relief
  (extensions, revival), and exhibit copies are NOT it. `null` if none exists.
- **`pet_325d`** — true when that petition invokes § 325(d) (or its
  same-or-substantially-the-same-art standard) as a ground; false when it is a
  genuine PO attack on the order on other grounds only. `null` when
  `pet_doc_id` is null.
- **`opp_doc_id`** — the paper filed by the **third-party requester** opposing
  THAT petition (`opposition` kind, or a `petition-paper` that is in substance
  the requester's opposition/response). `null` if none.
- **`dec_doc_id`** — the `decision` candidate whose text decides THAT patent
  owner petition (decision openings state whose petition of what date they
  address). A decision on some other petition is NOT it, even if it is the
  only decision. `null` if not yet decided.
- **`dec_outcome`** — from that decision's own text: `granted`, `dismissed`,
  or `denied` (`granted-in-part` → `granted`, note it). `null` when
  `dec_doc_id` is null.
- **`dec_325d`** — true when the decision substantively addresses the § 325(d)
  argument; false when it decides the petition without reaching 325(d).
  `null` when `dec_doc_id` is null.
- **`confidence`** — `high` | `medium` | `low`; **`note`** ≤200 chars.

## Hard rules

- Every doc id you output MUST be a `doc_id` from that entry's `candidates`
  (or null). Never invent an ID; never borrow across proceedings.
- Judge party and relief from the DOCUMENT TEXT, not from codes, dates, or
  page counts.
- Same-day duplicates (petition + its exhibit copies): pick the paper that IS
  the petition (states the relief sought), not an exhibit; note the duplicate.
- If the candidates' text is unreadable and you cannot attribute, echo the
  `flagged` values (including its 325(d) booleans) with `confidence":"low"`
  and a note — blanking is ONLY for the affirmative finding that no PO
  § 325(d) petition exists in the readable record.
- One line per manifest entry — no skips, no extras, no line breaks in values.
