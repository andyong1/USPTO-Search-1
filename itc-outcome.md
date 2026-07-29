# ITC Section 337 outcome classification (nightly AI step)

Classify the **outcome of each staged USITC Section 337 investigation** from the
text of its dispositive documents. Like the §325(d)/FWD jobs, this runs **inside
the scheduled Claude session** — the session itself does the classification with
its own tools; there is no API key and no nested `claude -p`.

## Procedure

1. Load env + stage a batch (one Bash command):

   ```bash
   set -a; . <(tr -d '\r' < grounds-secrets.env); set +a; export NODE_OPTIONS=--use-system-ca
   node itc-outcome-fetch.mjs --limit 60
   ```
   If it reports nothing to classify, stop.
2. Read `itc-work/outcome-work/manifest.json`, then each `itc-work/outcome-work/<investigation_number>.txt`.
3. For each investigation, append one JSON object (one line) to
   `itc-work/outcome-work/itc-outcome-out.jsonl` using the schema below.
4. Upload + republish (one Bash command):

   ```bash
   set -a; . <(tr -d '\r' < grounds-secrets.env); set +a; export NODE_OPTIONS=--use-system-ca
   node itc-outcome-upload.mjs && node edis-upload.mjs --publish-only
   ```

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
  - `terminated_default` — the violation was **presumed from the respondents' default** (facts taken as true under § 337(g)) rather than adjudicated on the merits; remedy issued against the defaulters. See **Default resolutions** in Guidance for the merits-vs-default test.
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
- **Default resolutions**: the deciding question is **how the violation was established, not whether respondents defaulted or which subsection the exclusion order cites**.
  - Use `terminated_default` (with the remedies) when the violation rests **solely on the default** — the Commission presumed the complaint's facts as true under § 337(g)(1) (no respondent appeared) or § 337(g)(2), without adjudicating infringement and domestic industry on the merits.
  - Use `violation_found` when there is an **affirmative merits finding** of violation (infringement + domestic industry actually adjudicated — e.g., on summary determination, or a contested hearing), *even if* some or all respondents defaulted and *even if* the exclusion order issued under § 337(d)(2)/(f). A GEO issued under § 337(d)(2) requires proof of a violation on the merits, so it is `violation_found`, not `terminated_default`.
  - Tie-breaker — follow the Commission's own language: "presumed the facts pursuant to § 337(g)" → `terminated_default`; "found a violation" / "affirmed the summary determination of violation" → `violation_found`. When a merits finding covers some respondents and pure default covers others, use `violation_found` with `violation":"partial"` and explain the split in the note.
- **Sub-proceedings**: the staged text may include later ENFORCEMENT, REMAND, MODIFICATION, ADVISORY, or RESCISSION proceedings that post-date the original determination. Classify the disposition of the **original investigation** (its merits/remedy outcome) and describe the sub-proceeding in the note. Do NOT let a later enforcement termination or a withdrawn *enforcement* complaint override the underlying violation/remedy — e.g., an investigation that issued an exclusion order by default is `terminated_default` even if a subsequent enforcement complaint was later withdrawn.
- A **partial** result is common (violation as to some patents/respondents, termination as to others). Set `violation":"partial"` and explain in the note.
- If only a settlement/consent/withdrawal appears (no merits ruling), set `violation":null` and the matching `terminated_*` disposition.
- If the staged text is empty/scanned or clearly insufficient to tell, set your best-guess disposition with `confidence":"low"` (or `pending` if truly nothing), and say so in the note. Do not invent facts.
- Base everything on the document text. This is a factual classification, not legal advice.

When done, `itc-outcome-out.jsonl` has exactly one line per staged investigation; then run Procedure step 4 (upload + republish).
