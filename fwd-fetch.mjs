// Stage PTAB final-written-decision (FWD) texts that need AI outcome verification
// (decision_text present, fwd_ai_v behind) into a local work folder for the
// nightly Claude session. Companion to fwd-upload.mjs; instructions in
// fwd-verify.md. The current regex outcome is deliberately NOT staged, so the AI
// read is independent.
//
// Requires POSTGRES_URL in the environment (grounds-secrets.env). Run from the
// uspto-search folder:
//     node fwd-fetch.mjs             # default batch (30, newest first)
//     node fwd-fetch.mjs --limit 1200 # full backfill
//
// Output: snq-cumulative/fwd-work/<trial_number>.txt  (one per decision)
//         snq-cumulative/fwd-work/manifest.json        (metadata per decision)

import { mkdir, writeFile, rm } from 'node:fs/promises';
import { sql } from '@vercel/postgres';

if (!process.env.POSTGRES_URL) {
  console.error('POSTGRES_URL is not set. Load it from grounds-secrets.env first.');
  process.exit(1);
}

const args = process.argv.slice(2);
const limitIdx = args.indexOf('--limit');
const LIMIT = limitIdx >= 0 ? Number(args[limitIdx + 1]) : 30;

const DIR = 'snq-cumulative/fwd-work';
await rm(DIR, { recursive: true, force: true });
await mkdir(DIR, { recursive: true });

const { rows } = await sql`
  SELECT trial_number, decision_text
  FROM ptab_fwd
  WHERE coalesce(decision_text, '') <> '' AND coalesce(fwd_ai_v, 0) < 1
  ORDER BY fwd_date DESC NULLS LAST
  LIMIT ${LIMIT}`;

const manifest = [];
for (const r of rows) {
  await writeFile(`${DIR}/${r.trial_number}.txt`, r.decision_text, 'utf-8');
  manifest.push({ trial_number: r.trial_number, char_count: (r.decision_text || '').length });
}
await writeFile(`${DIR}/manifest.json`, JSON.stringify(manifest, null, 1), 'utf-8');

const { rows: cnt } = await sql`SELECT count(*)::int AS n FROM ptab_fwd WHERE coalesce(decision_text,'') <> '' AND coalesce(fwd_ai_v,0) < 1`;
console.log(`${rows.length} FWD decision(s) staged in ${DIR} (${cnt[0].n} total awaiting AI verification).`);
console.log(rows.length ? 'Next: verify per fwd-verify.md -> write fwd-out.jsonl -> node fwd-upload.mjs' : 'Nothing to verify.');
try { await sql.end(); } catch { /* already closed */ }
