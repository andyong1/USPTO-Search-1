# ITC Section 337 holding summary (nightly AI step)

Write a short **plain-English "what the Commission held"** summary for each staged
USITC Section 337 investigation, from the text of its dispositive documents. Like
the §325(d)/outcome jobs, this runs **inside the scheduled Claude session** — the
session itself writes the summaries with its own tools; there is no API key and no
nested `claude -p`.

## Procedure

1. Load env + stage a batch (one Bash command):

   ```bash
   set -a; . <(tr -d '\r' < grounds-secrets.env); set +a; export NODE_OPTIONS=--use-system-ca
   node itc-summary-fetch.mjs --limit 40
   ```
   If it reports nothing to summarize, stop.
2. Read `itc-work/summary-work/manifest.json`, then each `itc-work/summary-work/<investigation_number>.txt`.
3. For each investigation, append one JSON object (one line) to
   `itc-work/summary-work/itc-summary-out.jsonl` using the schema below.
4. Upload (one Bash command):

   ```bash
   set -a; . <(tr -d '\r' < grounds-secrets.env); set +a; export NODE_OPTIONS=--use-system-ca
   node itc-summary-upload.mjs && node edis-upload.mjs --publish-only
   ```

## Input
- `itc-work/summary-work/<investigation_number>.txt` — one file per investigation, its dispositive documents concatenated, each under a header
  `===== [ROLE] <title> (<date>) · docId <id> =====` (roles: COMMISSION OPINION, FINAL INITIAL DETERMINATION (ALJ), COMMISSION ORDER (REMEDY), CONSENT ORDER, COMMISSION ORDER, COMMISSION NOTICE, INITIAL DETERMINATION (OTHER THAN FINAL)).
- Text is capped (head + tail); a `…[N characters omitted]…` marker means the middle was dropped — the holding/order is usually in the tail.

## What to write
The **Commission's final action controls** (it may affirm, reverse, or modify the ALJ's Initial Determination). Read the Commission Opinion and the final Commission Notice first; the ALJ's Final ID is secondary. Capture, in plain English: who the complainant is (if clear), whether a **violation was found** (and as to which patents/respondents, in general terms), what **remedy** issued (limited/general exclusion order, cease-and-desist orders), and how the matter **ended** if not on the merits (settlement, consent order, withdrawal, default). Remedies are announced in the Commission's final-determination notice/opinion.

## Output — append to `itc-work/summary-work/itc-summary-out.jsonl`
**One JSON object per line** (JSONL), one per investigation:

```json
{"investigation_number":"337-1000","summary":"The Commission found a Section 337 violation as to the asserted '123 and '456 patents and issued a limited exclusion order plus cease-and-desist orders against the defaulting respondents; it found no violation as to the '789 patent. The investigation was terminated as to two respondents on consent orders."}
```

Fields:
- **investigation_number** — from the file / manifest.
- **summary** — 2-4 sentences, plain English, no line breaks. State what the Commission actually held/ordered. Neutral and factual; do NOT editorialize or predict. If the text is a settlement/consent/withdrawal with no merits ruling, say so briefly. If the staged text is empty/scanned or clearly insufficient, write one sentence noting that the disposition could not be determined from the available text (do not invent facts).

## Guidance
- Base everything on the document text. This is a factual summary, not legal advice.
- Prefer the Commission's own language for the holding and remedy.
- For sub-proceedings (Enforcement/Remand/Modification/Advisory) that post-date the original determination, summarize the ORIGINAL investigation's merits/remedy outcome and mention the sub-proceeding only briefly if present.
- Keep it self-contained: a reader should understand the result without opening the documents.

When done, `itc-summary-out.jsonl` has exactly one line per staged investigation; then run Procedure step 4 (upload + republish).
