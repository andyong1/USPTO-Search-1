// Stage the "residual" petitions — those whose Related Matters the regex
// extractor left EMPTY but which have stored front-matter to read — for the
// nightly Claude session's AI litigation pass. Companion to lit-upload.mjs;
// instructions in lit-verify.md.
//
// Requires POSTGRES_URL in the environment (grounds-secrets.env). Run from the
// uspto-search folder:
//     node lit-fetch.mjs             # default batch (25)
//     node lit-fetch.mjs --limit 600 # full residual set
//
// Output: snq-cumulative/lit-work/<trial_number>.txt  (front-matter window)
//         snq-cumulative/lit-work/manifest.json        (+ petitioner/PO names)

import { mkdir, writeFile, rm } from 'node:fs/promises';
import { sql } from '@vercel/postgres';

if (!process.env.POSTGRES_URL) {
  console.error('POSTGRES_URL is not set. Load it from grounds-secrets.env first.');
  process.exit(1);
}

const args = process.argv.slice(2);
const limitIdx = args.indexOf('--limit');
const LIMIT = limitIdx >= 0 ? Number(args[limitIdx + 1]) : 25;

const DIR = 'snq-cumulative/lit-work';
await rm(DIR, { recursive: true, force: true });
await mkdir(DIR, { recursive: true });

const { rows } = await sql`
  SELECT pr.trial_number, pr.pet_frontmatter,
         coalesce(d.petitioner_name, f.petitioner_name) AS petitioner_name,
         coalesce(d.po_name, f.po_name) AS po_name
  FROM ptab_petition_refs pr
  LEFT JOIN ptab_decisions d ON d.trial_number = pr.trial_number
  LEFT JOIN ptab_fwd f ON f.trial_number = pr.trial_number
  WHERE coalesce(pr.pet_frontmatter, '') <> ''
    AND coalesce(array_length(pr.lit_petitioner, 1), 0) = 0
    AND coalesce(array_length(pr.lit_other, 1), 0) = 0
    AND coalesce(pr.lit_ai_v, 0) < 1
  ORDER BY pr.trial_number DESC
  LIMIT ${LIMIT}`;

const manifest = [];
for (const r of rows) {
  await writeFile(`${DIR}/${r.trial_number}.txt`, r.pet_frontmatter, 'utf-8');
  manifest.push({ trial_number: r.trial_number, petitioner_name: r.petitioner_name || '', po_name: r.po_name || '' });
}
await writeFile(`${DIR}/manifest.json`, JSON.stringify(manifest, null, 1), 'utf-8');

const { rows: cnt } = await sql`
  SELECT count(*)::int AS n FROM ptab_petition_refs
  WHERE coalesce(pet_frontmatter,'') <> '' AND coalesce(array_length(lit_petitioner,1),0)=0
    AND coalesce(array_length(lit_other,1),0)=0 AND coalesce(lit_ai_v,0) < 1`;
console.log(`${rows.length} petition(s) staged in ${DIR} (${cnt[0].n} total residual awaiting AI litigation pass).`);
console.log(rows.length ? 'Next: verify per lit-verify.md -> write lit-out.jsonl -> node lit-upload.mjs' : 'Nothing to verify.');
try { await sql.end(); } catch { /* already closed */ }
