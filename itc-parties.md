# ITC Section 337 parties + patents extraction (nightly AI step)

Extract the **complainants, respondents, asserted patents, accused products, and
requested remedies** for each staged USITC Section 337 investigation from the text
of its **Notice of Investigation (NOI)**. Like the §325(d)/FWD/outcome jobs, this
runs **inside the scheduled Claude session** — the session itself does the
extraction with its own tools; there is no API key and no nested `claude -p`.

## Procedure

1. Load env + stage a batch (one Bash command):

   ```bash
   set -a; . <(tr -d '\r' < grounds-secrets.env); set +a; export NODE_OPTIONS=--use-system-ca
   node itc-parties-fetch.mjs --limit 60
   ```
   If it reports nothing to stage, stop.
2. Read `itc-work/parties-work/manifest.json`, then each `itc-work/parties-work/<investigation_number>.txt`.
3. For each investigation, append one JSON object (one line) to
   `itc-work/parties-work/itc-parties-out.jsonl` using the schema below.
4. Upload + republish (one Bash command):

   ```bash
   set -a; . <(tr -d '\r' < grounds-secrets.env); set +a; export NODE_OPTIONS=--use-system-ca
   node itc-parties-upload.mjs && node edis-upload.mjs --publish-only
   ```

## Input
- `itc-work/parties-work/<investigation_number>.txt` — the NOI text for one investigation.
- The NOI is highly structured. It states, in order: the SUMMARY ("a complaint was
  filed … on behalf of <COMPLAINANT> … by reason of infringement of … U.S. Patent
  No. <N> …"), the requested remedy ("issue a limited exclusion order and cease and
  desist orders"), a numbered ORDERED section with (2) the plain-language accused-
  product scope and (3) the named parties: **(a) The complainant is:** and **(b) The
  respondents are:** (each entity with an address). A certificate of service repeats
  the complainant/respondents. Read the parties from section (3)(a)/(b) — it is
  authoritative and includes respondents who later default.

## Output — append to `itc-work/parties-work/itc-parties-out.jsonl`
**One JSON object per line** (JSONL), one per investigation:

```json
{"investigation_number":"337-1499","complainants":["Archer Aviation Inc."],"respondents":["Joby Aero, Inc.","Joby Aviation, Inc."],"asserted_patents":["11,945,594","12,162,614","8,469,306","12,103,404","12,472,087"],"accused_products":"eVTOL aircraft, power systems, and components including battery cells/packs","requested_remedies":["LEO","CDO"],"confidence":"high","note":"Archer v. Joby; 5 utility patents on eVTOL aircraft.","source_doc":"878407"}
```

Fields (use `null`/`[]` when a field doesn't apply):
- **investigation_number** — from the file / manifest.
- **complainants** — array of complainant entity names, as written (keep "Inc."/"LLC"; one entry per entity, do NOT merge into a combined string).
- **respondents** — array of respondent entity names from section (3)(b), each as an INDIVIDUAL entity (split combined listings — e.g. "Joby Aero, Inc. and Joby Aviation, Inc." → two entries). Include ALL named respondents even if the same corporate family.
- **asserted_patents** — array of the asserted U.S. patent numbers as written WITH commas, digits only (strip "U.S. Patent No." and the "(the '594 patent)" nickname). Keep a leading `D`/`RE`/`PP` for design/reissue/plant patents. `[]` if none stated.
- **accused_products** — the plain-language accused-product description (prefer the ORDERED paragraph (2) "plain language description … is '…'"; otherwise the SUMMARY phrase). One concise phrase, ≤ ~200 chars, no line breaks.
- **requested_remedies** — what the complaint REQUESTS (not what issues): `"LEO"` (limited exclusion order), `"GEO"` (general exclusion order), `"CDO"` (cease and desist order). Map "limited exclusion order"→LEO, "general exclusion order"→GEO, "cease and desist order(s)"→CDO. `[]` if unstated.
- **confidence** — `high` | `medium` | `low`. Use `low` when the NOI text is scanned/garbled/truncated or the parties/patents are unclear.
- **note** — one concise plain-text sentence (who v. who, N patents, tech). No line breaks.
- **source_doc** — the NOI docId (from the "NOI docId:" header line).

## Guidance
- **Do not confuse counsel with parties.** Law firms (e.g. "Gibson, Dunn & Crutcher LLP") and the "Office of Unfair Import Investigations"/OUII, government agencies (DOJ, CBP, FTC, NIH), and mediation/service recipients are NOT complainants or respondents. Only the entities in section (3)(a)/(b).
- If the NOI text is empty/scanned (very short) or clearly insufficient, output your best guess with `confidence":"low"` (or empty arrays) and say so in the note. Do not invent parties or patents.
- Base everything on the NOI text. This is a factual extraction, not legal advice.

When done, `itc-parties-out.jsonl` has exactly one line per staged investigation; then run Procedure step 4 (upload + republish).
