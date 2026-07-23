# Nightly §325(d) summarization (AI step in the grounds top-up)

Summarize the §325(d) / prior-challenge discussion in each staged reexam
determination. Runs inside the scheduled Claude session after `grounds-topup.sh`;
the OCR text is staged by `d325-fetch.mjs` and results are uploaded by
`d325-upload.mjs`.

## Procedure

1. `node d325-fetch.mjs` (POSTGRES_URL already in env from grounds-secrets.env).
   If it reports nothing to summarize, stop.
2. Read `snq-cumulative/d325-work/manifest.json`, then each `<doc_id>.txt`.
3. For each document, append one JSON line to `snq-cumulative/d325-work/d325-out.jsonl`:

```json
{"doc_id": "...", "addressed": "Yes", "summary": "..."}
```

4. `node d325-upload.mjs` — validates and uploads; rejects malformed rows.

## Fields

**`addressed`** — exactly one of:
- `"Yes"` — the order contains a §325(d) discussion (including one concluding
  §325(d) is *not applicable* — that is still "addressed").
- `"No"` — no §325(d) discussion at all.
- `"No explicit §325(d) section located"` — the order plainly should discuss it
  (e.g. references a prior challenge) but no section is found in the text.
- `"Text quality too low"` — OCR too garbled to summarize reliably.

**`summary`** — 2–4 sentences, plain prose, required when `addressed` is
`"Yes"`; otherwise `null`, except that a short note is encouraged where context
helps (e.g. a prior challenge exists but the order never cites §325(d) and
rests on the SNQ analysis instead). Cover, when present in the order:
- Whether there were prior Office post-grant challenges to the patent (IPR/PGR/
  prior reexam), and which.
- Whether the request's art or arguments were previously presented (cited in
  original prosecution / in a prior proceeding), and the order's take —
  e.g. "used in a new light", "materially different grounds", cumulative.
- The order's bottom line: §325(d) not applicable / discretion not exercised /
  request denied under §325(d).
- If the patent owner raised §325(d) and the examiner rejected the argument, say so.

Style — match the existing tracker's voice (factual, no hedging, no citations):
> "No prior Office post-grant challenges to the patent. The order states 325(d)
> is not applicable. Li was the sole cited reference for the request, and was
> cited during original examination, but used in a new light in the request."

## Rules

- Base every statement ONLY on the document text. Never import outside knowledge
  of the patent or parties. If the text is ambiguous, say less, not more.
- Denials (doc_kind `denial`) often turn on §325(d)/SNQ overlap — capture the
  reasoning for why the art was cumulative or previously considered.
- OCR artifacts (dropped spaces, misread characters) are normal; summarize
  through them unless meaning is genuinely unrecoverable, then use
  `"Text quality too low"`.
- Keep each summary under ~1,200 characters. No markdown, no line breaks inside
  the summary string.
