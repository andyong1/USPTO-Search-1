// Pull reexam determinations that need an AI §325(d) summary (OCR text stored,
// d325_sum_v behind) into a local work folder for the nightly Claude session to
// read. Companion to d325-upload.mjs; instructions in d325-summarize.md.
//
// Requires POSTGRES_URL in the environment (grounds-secrets.env). Run from the
// uspto-search folder:
//     node d325-fetch.mjs               # default batch (12, newest first)
//     node d325-fetch.mjs --limit 30    # bigger backfill batch
//
// Output: snq-cumulative/d325-work/<doc_id>.txt   (one per document)
//         snq-cumulative/d325-work/manifest.json  (metadata for each doc)

import { mkdir, writeFile, rm } from 'node:fs/promises';
import { sql } from '@vercel/postgres';

if (!process.env.POSTGRES_URL) {
  console.error('POSTGRES_URL is not set. Load it from grounds-secrets.env first.');
  process.exit(1);
}

const args = process.argv.slice(2);
const limitIdx = args.indexOf('--limit');
const LIMIT = limitIdx >= 0 ? Number(args[limitIdx + 1]) : 12;

const DIR = 'snq-cumulative/d325-work';
await rm(DIR, { recursive: true, force: true }); // stale work must not be re-summarized
await mkdir(DIR, { recursive: true });

const { rows } = await sql`
  SELECT doc_id, application_number, doc_kind, official_date, char_count, text
  FROM reexam_doc_text
  WHERE coalesce(d325_sum_v, 0) < 1 AND coalesce(text, '') <> ''
  ORDER BY official_date DESC NULLS LAST
  LIMIT ${LIMIT}`;

const manifest = [];
for (const r of rows) {
  await writeFile(`${DIR}/${r.doc_id}.txt`, r.text, 'utf-8');
  manifest.push({ doc_id: r.doc_id, application_number: r.application_number, doc_kind: r.doc_kind, official_date: String(r.official_date || '').slice(0, 10), char_count: r.char_count });
}
await writeFile(`${DIR}/manifest.json`, JSON.stringify(manifest, null, 1), 'utf-8');

const { rows: cnt } = await sql`SELECT count(*)::int AS n FROM reexam_doc_text WHERE coalesce(d325_sum_v,0) < 1 AND coalesce(text,'') <> ''`;
console.log(`${rows.length} determination(s) staged in ${DIR} (${cnt[0].n} total awaiting summary).`);
console.log(rows.length ? 'Next: summarize per d325-summarize.md -> write d325-out.jsonl -> node d325-upload.mjs' : 'Nothing to summarize.');
process.exit(0);
