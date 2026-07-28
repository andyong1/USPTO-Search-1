# ITC Section 337 outcome classification

You are classifying the **outcome of a USITC Section 337 investigation** from the
text of its dispositive documents. This runs as a local batch: read each staged
file and append one JSON object per investigation to the output file.

## Input
- `itc-work/outcome-work/manifest.json` — the list of investigations and their staged docs.
- `itc-work/outcome-work/<investigation_number>.txt` — one file per investigation, containing its dispositive documents concatenated, each under a header:
  `===== [ROLE] <title> (<date>) · docId <id> =====`
  Roles: COMMISSION OPINION, FINAL INITIAL DETERMINATION (ALJ), COMMISSION ORDER (REMEDY), CONSENT ORDER, COMMISSION ORDER, COMMISSION NOTICE, INITIAL DETERMINATION (OTHER THAN FINAL).
- Text is capped (head + tail); a `…[N characters omitted]…` marker means the middle was dropped — the holding/order is usually in the tail.

## What to decide
The **Commission's final action controls** (it may affirm, reverse, or modify the ALJ's Initial Determination). Read the Commission Opinion and the final Commission Notice first; the ALJ's Final ID is secondary. Remedies are announced in the Commission's final-determination notice/opinion (there is no separate "exclusion order" document), so read them from the text.

## Output — append to `itc-work/outcome-work/itc-outcome-out.jsonl`
**One JSON object per line** (JSONL), one per investigation:

```json
{"investigation_number":"337-1000","disposition":"violation_found","violation":"partial","remedies":["LEO","CDO"],"commission_action":"affirmed_in_part","confidence":"high","note":"Commission found a violation as to the '000 patent; issued an LEO and CDOs; terminated as to other respondents by consent order.","source_docs":["744413","738721"]}
```

Fields (use exactly these enum values; use `null` when a field doesn't apply):
- **investigation_number** — from the file / manifest.
- **disposition** — the terminal outcome:
  - `violation_found` — Commission found a Section 337 violation (any respondent/patent).
  - `no_violation` — Commission found no violation.
  - `terminated_settlement` — terminated on a settlement agreement.
  - `terminated_consent` — terminated on a consent order.
  - `terminated_default` — resolved by default / consent to judgment against defaulting respondents (with remedy).
  - `terminated_withdrawal` — complaint withdrawn.
  - `terminated_arbitration` — terminated for arbitration.
  - `terminated_other` — other termination (e.g., partial, procedural) where none of the above fits.
  - `pending` — no terminal determination in the text.
- **violation** — `full` | `partial` (some patents/respondents only) | `none` | `null` (not adjudicated, e.g., pure settlement).
- **remedies** — array of any issued: `"LEO"` (limited exclusion order), `"GEO"` (general exclusion order), `"CDO"` (cease and desist order). `[]` if none.
- **commission_action** — the Commission's action on the ALJ's ID: `affirmed` | `reversed` | `modified` | `affirmed_in_part` | `not_reviewed` (Commission declined review, ID became final) | `null` (no ID reviewed, e.g., settlement).
- **confidence** — `high` | `medium` | `low`. Use `low` when text is thin/scanned/ambiguous.
- **note** — one concise sentence stating what happened (who/what/remedy). Plain text, no line breaks.
- **source_docs** — array of the `docId`s you relied on (from the headers). Optional but preferred.

## Guidance
- If the investigation has an **enforcement/remand/modification** posture in the text, classify the *most recent controlling* action; mention the posture in the note.
- A **partial** result is common (violation as to some patents/respondents, termination as to others). Set `violation":"partial"` and explain in the note.
- If only a settlement/consent/withdrawal appears (no merits ruling), set `violation":null` and the matching `terminated_*` disposition.
- If the staged text is empty/scanned or clearly insufficient to tell, set your best-guess disposition with `confidence":"low"` (or `pending` if truly nothing), and say so in the note. Do not invent facts.
- Base everything on the document text. This is a factual classification, not legal advice.

When done, `itc-outcome-out.jsonl` should have exactly one line per staged investigation. Then the user runs `node itc-outcome-upload.mjs`.
