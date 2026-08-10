// Backfill: sweep tracked reexam proceedings' documents feeds and harvest all
// petition-trail docs (petitions / oppositions / decisions) into
// reexam_petition_docs. DIRECT from USPTO (local key → zero Vercel transfer).
// The default (non-gap) full sweep is one-time -- the ongoing cron steps cover
// determined=false, ordered-not-concluded, AND (as of 2026-08) denied
// proceedings going forward. --gap covers the remaining, smaller set (concluded
// proceedings, and ones aged out of the watch window) on a recurring schedule.
//
//     set -a && . ./grounds-secrets.env && set +a && node pettrail-backfill.mjs [--gap] [--limit N] [--offset M]

import { sql } from '@vercel/postgres';
import { fetchDocuments } from './lib/uspto.js';
import { recordPetitionDocs, recordUnclassifiedPetitionCode, pruneClassifiedPetitionCodes } from './lib/db.js';
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
//
// --gap restricts the sweep to proceedings that the ongoing hourly cron doesn't
// (fully) reach: scanOne covers `determined = false`, detectConclusionsStep
// covers ordered-but-not-concluded, and detectDeniedPetitionsStep covers denied
// proceedings -- which together leave concluded proceedings and ones aged out
// of the 24-month watch window. (Denied proceedings are still included in this
// query's result set too -- harmless redundant work, since detectDeniedPetitionsStep
// already checks them every ~2 days -- but the SQL wasn't narrowed further since
// the population is tiny either way.) That's the set worth re-checking on a
// schedule; it's ~1/4 the full universe.
const GAP = args.includes('--gap');
const { rows } = GAP
  ? await sql`
      WITH allp AS (
        SELECT application_number FROM reexam_watch
        UNION SELECT application_number FROM reexam_determinations
      ),
      covered_scan AS (SELECT application_number FROM reexam_watch WHERE NOT determined),
      covered_cert AS (
        SELECT DISTINCT d.application_number FROM reexam_determinations d
        LEFT JOIN reexam_conclusions c ON c.application_number = d.application_number
        WHERE d.determination_code IN ('RXREXO','RX.SE.ORDER') AND c.cert_doc_id IS NULL
      )
      SELECT application_number FROM allp
      WHERE application_number IS NOT NULL
        AND application_number NOT IN (SELECT application_number FROM covered_scan)
        AND application_number NOT IN (SELECT application_number FROM covered_cert)
      ORDER BY application_number LIMIT ${LIMIT} OFFSET ${OFFSET}`
  : await sql`
      SELECT application_number FROM (
        SELECT application_number FROM reexam_watch
        UNION
        SELECT application_number FROM reexam_determinations
      ) s
      WHERE application_number IS NOT NULL
      ORDER BY application_number LIMIT ${LIMIT} OFFSET ${OFFSET}`;
console.log(`Sweeping ${rows.length} proceeding(s) — ${GAP ? 'GAP set (not covered by either ongoing harvest)' : 'all known controls (watch ∪ determinations)'}, offset ${OFFSET}…`);

// Same unrecognized-code capture the cron's harvest does — kept in sync with
// api/cron/reexam-scan.js. This sweep walks EVERY wrapper, so it is by far the
// best source of candidate codes; skipping it here would leave the audit
// dependent on the cron slowly rotating through the same ground.
const PETITIONISH = /PET|RQ|REQ|WAIV|EXT|SUSP|RECON|REV/;
const PETITIONISH_DESC = /petition|request|extension|waiv|suspend|reconsider|review/i;

let swept = 0, withPets = 0, docsTotal = 0, failed = 0, flagged = 0;
const recognized = new Set(); // codes that DID classify — used to prune stale audit rows
for (const r of rows) {
  const app = r.application_number;
  try {
    const docs = await fetchDocuments(app);
    const petDocs = [];
    const unknown = new Map();
    for (const d of docs) {
      const code = (d.documentCode || '').toUpperCase();
      const pet = classifyPetitionDoc(code, d.description);
      if (pet) { recognized.add(code); petDocs.push({ doc_id: d.documentIdentifier, official_date: (d.officialDate || '').slice(0, 10), doc_code: code, kind: pet.kind, outcome: pet.outcome }); continue; }
      if (code && !unknown.has(code) && (PETITIONISH.test(code) || PETITIONISH_DESC.test(d.description || ''))) {
        unknown.set(code, { description: d.description || '', docId: d.documentIdentifier });
      }
    }
    if (petDocs.length) { await recordPetitionDocs(app, petDocs); withPets++; docsTotal += petDocs.length; }
    for (const [code, u] of unknown) {
      try { await recordUnclassifiedPetitionCode(code, u.description, app, u.docId); flagged++; } catch { /* advisory */ }
    }
    swept++;
    if (swept % 50 === 0) console.log(`  …${swept}/${rows.length} swept (${docsTotal} petition docs so far)`);
  } catch (e) { failed++; console.log(`${app}: ${e.message.slice(0, 100)}`); }
}
// Any code that classified somewhere in the corpus is no longer a review item.
const pruned = await pruneClassifiedPetitionCodes([...recognized]);
console.log(`\nDone. Swept ${swept}, failed ${failed}. ${docsTotal} petition doc(s) across ${withPets} proceeding(s). ${flagged} unrecognized-code sighting(s) logged; ${pruned} now-classified code(s) pruned from the audit.`);
const { rows: t } = await sql`SELECT kind, count(*)::int n FROM reexam_petition_docs GROUP BY kind ORDER BY kind`;
console.log('table now:', t.map((x) => `${x.kind}=${x.n}`).join(' '));
try { await sql.end(); } catch { /* */ }
