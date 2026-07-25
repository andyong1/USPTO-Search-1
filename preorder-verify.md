# Nightly AI pass — pre-order requester-petition attribution

On the /reexam-preorder page, each patent-owner pre-order SNQ submission may be
followed by a **third-party requester petition** (asking leave to file a reply
to the patent owner's submission) and the Office's **decision on that petition**.
The document codes are party-agnostic (`RXPET.` = "Receipt of Petition in a
Reexam" is used for BOTH parties' petitions, and several petitions may be
decided the same day), so the code heuristic can flag a patent-owner petition —
or the decision on one — by mistake. Your job: read the candidates' opening
pages and SELECT the true requester petition and its decision. Text staged by
`preorder-fetch.mjs`, results uploaded by `preorder-upload.mjs`.

## Procedure

1. `node preorder-fetch.mjs` (POSTGRES_URL already in env). If it reports
   nothing, stop.
2. Read `snq-cumulative/preorder-work/manifest.json`. Each entry has:
   - `preorder_date` — the patent owner's RX.PRO.PO submission date,
   - `flagged` — what the code heuristic currently attributes,
   - `reply_dates` — dates of RX.PRO.RR requester replies (a requester petition
     usually accompanies its reply),
   - `candidates[]` — every petition/decision candidate: `doc_id`, `code`,
     `date`, `kind` (petition|decision), `file`, `chars`.
3. Read each candidate's `snq-cumulative/preorder-work/<file>` (first ~3 pages).
4. Append one JSON line per proceeding to
   `snq-cumulative/preorder-work/preorder-out.jsonl`:

```json
{"application_number":"90016339","pet_doc_id":"MRJ1QHWFX65X6X4","dec_doc_id":"MRZ9NTMR120X224","dec_outcome":"granted","confidence":"high","note":""}
```

5. `node preorder-upload.mjs` — validates against the manifest and uploads.

## How to judge

- **`pet_doc_id`** — the candidate (kind `petition`) actually filed by the
  **third-party requester** seeking to submit/enter its reply to the patent
  owner's pre-order submission (typically a 37 CFR 1.182/1.183 petition; may
  also seek a page-limit waiver for the reply). Identify the filer from the
  document text itself: the caption, opening paragraph ("Third Party
  Requester ... hereby petitions ..."), and signature block. A petition filed
  by the **patent owner** (e.g. to strike or to not enter the requester's
  reply) is NOT it. `null` if no requester petition exists among the candidates.
- **`dec_doc_id`** — the candidate (kind `decision`) that **decides the
  requester's petition**. Decision openings state whose petition they address
  ("the petition filed <date> by the Third Party Requester ..."). A decision on
  a patent-owner petition is NOT it, even if it is the only/earliest decision.
  `null` if the requester's petition has no decision yet.
- **`dec_outcome`** — from that decision's own text: `granted`, `dismissed`, or
  `denied`. `null` when `dec_doc_id` is null. (`granted-in-part` → `granted`,
  note it.)
- **`confidence`** — `high` | `medium` | `low`.
- **`note`** — ≤200 chars; "" when clean. Note anything odd (PO-only petitions,
  unreadable text, decision addresses both petitions, etc.).

Hints, not rules: the requester petition is often filed the SAME DAY as an
RX.PRO.RR reply (`reply_dates`); patent-owner petitions often follow later.
Decide from the text, not from dates alone.

## Hard rules

- `pet_doc_id`/`dec_doc_id` MUST be a `doc_id` from that entry's `candidates`
  (or null). Never invent an ID; never borrow from another proceeding.
- Judge party from the DOCUMENT TEXT (caption / opening / signature), not from
  document codes or filing order.
- If a candidate's text is empty or unreadable garbage, you cannot attribute it;
  if no readable candidate establishes the requester petition, echo the
  `flagged` values as your outputs with `confidence":"low"` and a note (this
  keeps the heuristic display rather than blanking on ignorance). Blank
  (`null`) is ONLY for the affirmative finding that the readable record shows
  no requester petition / no decision on it.
- One line per manifest entry — no skips, no extras, no line breaks in values.
