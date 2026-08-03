# Requester rescan (options A + B) — classification spec

Re-processing the "empty bucket" (third-party reexams with a request doc but no
requester name yet). Two sources of a requester identity, in priority order:

**A — explicit (preferred).** The request's front pages (now OCR'd to 20pp) name
the requester: *"X ('Requester') requests/submits this request for ex parte
reexamination"*, or a "real party in interest" statement. This is authoritative.

**B — litigation inference (fallback).** If the request never names the party,
use the disclosed co-pending litigation: the requester is the case-caption party
that is **not the patent owner** (the patent owner is usually the plaintiff
asserting the patent; the requester is the adversary seeking to invalidate it).

## Input (per manifest entry)
- `application_number`, `req_file` (the OCR'd request front text),
- `patent_owner` (from ODP — may be null),
- `litigation` (array of case captions like `"AutoConnect Holdings LLC v. General Motors LLC"`).

## Output — one JSON line per entry to `snq-cumulative/reqid-rescan/reqid-out.jsonl`
```json
{"application_number":"90019703","requester_name":"Seirus Innovative Accessories, Inc.","confidence":"medium","note":"explicit: 'asserted against the Requester' in Columbia v. Seirus"}
```
- `requester_name` ≤120 chars (empty string if none). `note` ≤200 chars, no line breaks.
- `confidence`: **high** = request explicitly designates the party `("Requester")`;
  **medium** = strongly implied by the request text (e.g. "asserted against the
  Requester" in a named suit); **low** = inferred from litigation caption only (B).

## Rules
1. **A first.** If the request text names the requesting party, return it (high /
   medium). Clean OCR noise ("Sam ung"→"Samsung"); keep legal suffix (Inc./LLC/Ltd.).
2. **Never** return counsel / law firm / attorney, the patent owner, or the USPTO.
   A law firm designated "Requester" with no client behind it → not a name.
3. **B fallback** (only if A yields nothing): parse each caption as "P v. D".
   Match `patent_owner` to one side (allow name variation — "Samsung Electronics
   Co., Ltd." ≈ "Samsung"). The requester is the OTHER side. Return it with
   `confidence":"low"`, note = `inferred from litigation: <caption>`.
   - If `patent_owner` is null and you can't tell which side is the PO → skip.
   - Skip "Schedule A" / John-Doe captions ("The Individuals, Corporations,
     Limited Liability Companies…") — the defendants are unnamed.
   - If multiple captions name different, conflicting adversaries → skip (ambiguous).
   - If several captions share the same single adversary → that's the requester.
4. If neither A nor B produces a confident name → `requester_name":""`,
   `confidence":"low"`, short note (the row stays "—").
