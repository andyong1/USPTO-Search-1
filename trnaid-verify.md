# TRNA fallback — third-party requester identity (from the Transmittal)

For third-party ex parte reexams the request-document pass (reqid-*) left WITHOUT
a requester name, the **Transmittal of New Application** (doc code `TRNA`) carries
a structured field that names the requester directly:

> **The name and address of the person requesting reexamination is:**
> Par-Kan Co., LLC
> 2915 West 900 South
> Silver Lake, IN 46982

Read that field and extract the requester. Text staged by `trnaid-fetch.mjs`
(image-only TRNAs are OCR'd by `preorder-ocr.py`); results uploaded by
`trnaid-upload.mjs`. This fills gaps only — the upload never overwrites a name
that is already present.

## Procedure

1. `node trnaid-fetch.mjs --limit N` (POSTGRES_URL already in env). If it reports
   "Nothing to analyze.", stop.
2. `cat preorder-ocr.py | python - trnaid-work 4 8000` (OCR the image-only cover
   pages — same DLP caveat as the other OCR steps).
3. Read `snq-cumulative/trnaid-work/manifest.json` (each entry: `application_number`,
   `trna_doc_id`, `trna_date`, `trna_file`), then each `snq-cumulative/trnaid-work/<trna_file>`.
4. Append one JSON line per proceeding to
   `snq-cumulative/trnaid-work/trnaid-out.jsonl`:

```json
{"application_number":"90016279","requester_name":"Par-Kan Co., LLC","confidence":"high","note":""}
```

5. `node trnaid-upload.mjs` — validates and stores into `reexam_requester` (gap-fill only).

## What to extract

- **`requester_name`** — the **real party in interest** named under **"The name
  and address of the person requesting reexamination is:"**, e.g. "Par-Kan Co.,
  LLC", "Apple Inc.", "Nearmap US, Inc.", "Unified Patents, LLC". Take the entity
  name line(s) preceding the street address; drop the address. Clean obvious OCR
  noise ("Par Kan co., LLC" → "Par-Kan Co., LLC"; "Sam ung" → "Samsung"); keep the
  legal suffix (Inc./LLC/Ltd./Corp.).

### Practitioner vs. party — the key judgment

This field very often names the **filing practitioner or law firm**, not the
requester itself. Distinguish:

- **"<Person>, <Law Firm LLP>"** or **"<Person> c/o <Firm>"** or a bare **law
  firm / law office** (LLP, "Law Offices", a `PLLC`/`PC` that is a person's name,
  patent-agent) → this is COUNSEL. If no actual party is identifiable, return
  empty `requester_name`, `confidence":"low"`, note "field names counsel only".
- **An operating company / organization** (e.g. "Nearmap US, Inc.", "Excel Driver
  Services, LLC", "The Beverage Ranch, LLC", "Avient Protective Materials B.V.",
  "Samsung Electronics Co., Ltd.") → that company IS the requester. If a contact
  person precedes it (e.g. "Andrea Shoffstall / Unified Patents, LLC"), record the
  COMPANY ("Unified Patents, LLC"), not the person. When two affiliated entities
  are listed (e.g. Samsung Electronics Co., Ltd. and Samsung Electronics America,
  Inc.), record the parent/first (note the affiliate).
- **A bare individual with a residential/foreign address and no firm** may be a
  pro se requester; record the individual only if there is no sign they are an
  agent, at `confidence":"medium"`. If it is ambiguous whether the individual is
  the party or an agent, prefer empty + `low` with a note.

## Hard rules

- Extract ONLY from the staged TRNA text.
- Use ONLY the **"person requesting reexamination"** field. Do NOT return the
  **"party served"** field (that is the patent owner / its counsel).
- Precision over recall: it is better to leave `requester_name` empty than to
  record a law firm or attorney as the requester.
- If the text is missing ("(no text extracted)"), the field is absent/garbled, or
  you cannot confidently read the name, return empty `requester_name`,
  `confidence":"low"`, and a short note (the row stays "—" until re-run).
- `requester_name` ≤120 chars, `note` ≤200 chars; one JSON line per manifest
  entry; no line breaks in values.
