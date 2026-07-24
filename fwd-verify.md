# Nightly AI verification of PTAB final-written-decision (FWD) outcomes

Read each PTAB final written decision and independently determine its outcome —
which challenged claims the Board held unpatentable vs. upheld. This is a second
read that measures and corrects the regex classifier and adds claim-level detail
for partial outcomes. Runs inside the scheduled Claude session; text is staged by
`fwd-fetch.mjs` and results uploaded by `fwd-upload.mjs`.

You are NOT shown the existing classification — judge only from the decision text.

## Procedure

1. `node fwd-fetch.mjs` (POSTGRES_URL already in env). If it reports nothing to
   verify, stop.
2. Read `snq-cumulative/fwd-work/manifest.json`, then each
   `snq-cumulative/fwd-work/<trial_number>.txt`.
3. For each decision, append one JSON line to
   `snq-cumulative/fwd-work/fwd-out.jsonl`:

```json
{"trial_number":"IPR2023-00123","outcome":"partial","unpatentable":"1-5, 8","upheld":"6, 7","confidence":"high","note":""}
```

4. `node fwd-upload.mjs` — validates and uploads.

## `outcome` — exactly one of:

- **`petitioner_all`** — ALL challenged claims held unpatentable (petitioner total win).
- **`po_none`** — NO challenged claims held unpatentable (patent owner total win); the Board found petitioner did not carry its burden on any claim.
- **`partial`** — SOME challenged claims unpatentable, others upheld.
- **`adverse_judgment`** — judgment entered against the patent owner without a merits decision (e.g. PO requested adverse judgment / disclaimed all claims). A PO loss, but not on the merits.
- **`settled`** — proceeding terminated on settlement (35 U.S.C. 317) with no merits outcome.
- **`needs_review`** — genuinely cannot determine from the text (garbled, truncated, or not actually a final written decision). Use sparingly.

## The other fields

- **`unpatentable`** — the challenged claims held unpatentable, as a claim list ("1-5, 8"). Empty "" for po_none / adverse_judgment / settled.
- **`upheld`** — the challenged claims NOT held unpatentable (survived), as a claim list. Empty "" for petitioner_all. For partial, unpatentable + upheld should together cover the challenged claims.
- **`confidence`** — `high` / `medium` / `low`.
- **`note`** — ≤200 chars, optional. Use for caveats: Director-review/remand, claims added by motion to amend, a caption that conflicts with the body, OCR trouble, etc. "" otherwise.

## Rules

- Decide from the **holding** — the caption ("Final Written Decision Determining
  [All/No/Some] Challenged Claims Unpatentable") AND the ORDER/conclusion. If the
  caption and body conflict, trust the body and flag it in `note`.
- Be **negation-aware**: "Petitioner has NOT shown claims X are unpatentable"
  means those claims are **upheld**, not unpatentable. "has not shown that ANY
  challenged claim is unpatentable" = po_none.
- Only **challenged** claims count. Ignore claims not at issue. Motion-to-amend
  substitute claims: note them but classify on the originally challenged claims.
- "Claims held unpatentable" / "are unpatentable" / "are cancelled" → unpatentable.
  "not shown to be unpatentable" / "not unpatentable" / "patentable" → upheld.
- Base everything ONLY on this decision's text — no outside knowledge of the
  patent or parties. If it is not actually an FWD (e.g. an institution decision
  or a termination order), pick adverse_judgment/settled/needs_review as fits and
  note it.
- Claim lists only in the two list fields (digits/commas/hyphens); no prose, no
  line breaks anywhere in the JSON.
