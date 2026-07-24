// Stage reexamination certificates that need AI claim-disposition verification
// (cached OCR text present, cert_ai_v behind) into a local work folder for the
// nightly Claude session to read. Companion to cert-upload.mjs; instructions in
// cert-verify.md.
//
// Requires POSTGRES_URL in the environment (grounds-secrets.env). Run from the
// uspto-search folder:
//     node cert-fetch.mjs             # default batch (25, newest first)
//     node cert-fetch.mjs --limit 400 # bigger backfill batch
//
// Output: snq-cumulative/cert-work/<application_number>.txt  (one per certificate)
//         snq-cumulative/cert-work/manifest.json             (metadata per cert)

import { mkdir, writeFile, rm } from 'node:fs/promises';
import { sql } from '@vercel/postgres';

if (!process.env.POSTGRES_URL) {
  console.error('POSTGRES_URL is not set. Load it from grounds-secrets.env first.');
  process.exit(1);
}

const args = process.argv.slice(2);
const limitIdx = args.indexOf('--limit');
const LIMIT = limitIdx >= 0 ? Number(args[limitIdx + 1]) : 25;

const DIR = 'snq-cumulative/cert-work';
await rm(DIR, { recursive: true, force: true }); // stale work must not be re-verified
await mkdir(DIR, { recursive: true });

const { rows } = await sql`
  SELECT application_number, cert_doc_id, cert_text
  FROM reexam_conclusions
  WHERE cert_doc_id IS NOT NULL AND coalesce(cert_text, '') <> '' AND coalesce(cert_ai_v, 0) < 1
  ORDER BY cert_date DESC NULLS LAST
  LIMIT ${LIMIT}`;

const manifest = [];
for (const r of rows) {
  await writeFile(`${DIR}/${r.application_number}.txt`, r.cert_text, 'utf-8');
  manifest.push({ application_number: r.application_number, cert_doc_id: r.cert_doc_id, char_count: (r.cert_text || '').length });
}
await writeFile(`${DIR}/manifest.json`, JSON.stringify(manifest, null, 1), 'utf-8');

const { rows: cnt } = await sql`SELECT count(*)::int AS n FROM reexam_conclusions WHERE cert_doc_id IS NOT NULL AND coalesce(cert_text,'') <> '' AND coalesce(cert_ai_v,0) < 1`;
console.log(`${rows.length} certificate(s) staged in ${DIR} (${cnt[0].n} total awaiting AI verification).`);
console.log(rows.length ? 'Next: verify per cert-verify.md -> write cert-out.jsonl -> node cert-upload.mjs' : 'Nothing to verify.');
try { await sql.end(); } catch { /* already closed */ }
