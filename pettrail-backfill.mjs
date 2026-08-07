// ONE-TIME backfill: sweep every tracked reexam proceeding's documents feed and
// harvest all petition-trail docs (petitions / oppositions / decisions) into
// reexam_petition_docs. DIRECT from USPTO (local key → zero Vercel transfer).
// Going forward, the certificate-check scan harvests new docs for free, so this
// sweep never needs to run again (concluded proceedings no longer change).
//
//     set -a && . ./grounds-secrets.env && set +a && node pettrail-backfill.mjs [--limit N] [--offset M]

import { sql } from '@vercel/postgres';
import { fetchDocuments } from './lib/uspto.js';
import { recordPetitionDocs } from './lib/db.js';
import { classifyPetitionDoc } from './lib/petitions.js';

if (!process.env.POSTGRES_URL || !process.env.USPTO_API_KEY) {
  console.error('POSTGRES_URL and USPTO_API_KEY required — source grounds-secrets.env.');
  process.exit(1);
}

const args = process.argv.slice(2);
const num = (flag, def) => { const i = args.indexOf(flag); return i >= 0 ? Number(args[i + 1]) : def; };
const LIMIT = num('--limit', 100000);
const OFFSET = num('--offset', 0);

// EVERY known proceeding, not just those with a determination on file. The first
// version of this sweep queried reexam_determinations only, which silently missed
// proceedings still awaiting an order — exactly where PRE-ORDER petitions live
// (e.g. 90016272 and 90016411 each had an RXPET. + RXPTDI that never got picked up).
const { rows } = await sql`
  SELECT application_number FROM (
    SELECT application_number FROM reexam_watch
    UNION
    SELECT application_number FROM reexam_determinations
  ) s
  WHERE application_number IS NOT NULL
  ORDER BY application_number LIMIT ${LIMIT} OFFSET ${OFFSET}`;
console.log(`Sweeping ${rows.length} proceeding(s) — all known controls (watch ∪ determinations), offset ${OFFSET}…`);

let swept = 0, withPets = 0, docsTotal = 0, failed = 0;
for (const r of rows) {
  const app = r.application_number;
  try {
    const docs = await fetchDocuments(app);
    const petDocs = [];
    for (const d of docs) {
      const pet = classifyPetitionDoc((d.documentCode || '').toUpperCase(), d.description);
      if (pet) petDocs.push({ doc_id: d.documentIdentifier, official_date: (d.officialDate || '').slice(0, 10), doc_code: (d.documentCode || '').toUpperCase(), kind: pet.kind, outcome: pet.outcome });
    }
    if (petDocs.length) { await recordPetitionDocs(app, petDocs); withPets++; docsTotal += petDocs.length; }
    swept++;
    if (swept % 50 === 0) console.log(`  …${swept}/${rows.length} swept (${docsTotal} petition docs so far)`);
  } catch (e) { failed++; console.log(`${app}: ${e.message.slice(0, 100)}`); }
}
console.log(`\nDone. Swept ${swept}, failed ${failed}. ${docsTotal} petition doc(s) across ${withPets} proceeding(s).`);
const { rows: t } = await sql`SELECT kind, count(*)::int n FROM reexam_petition_docs GROUP BY kind ORDER BY kind`;
console.log('table now:', t.map((x) => `${x.kind}=${x.n}`).join(' '));
try { await sql.end(); } catch { /* */ }
