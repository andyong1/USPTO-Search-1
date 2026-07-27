// Deterministic (no AI): backfill the operative Office action's identity
// (doc id / date / code) for final-oa NIRC rows that lost it. oa-fetch only
// cached this when the action had a text layer; image-only actions (OCR'd
// separately) left oa_doc_id/oa_date/oa_code NULL, so the /reexam-nirc page
// couldn't render the OA date or a View/Download link. This re-derives the
// action with the SAME pick rule oa-fetch used (latest RXFR.. final rejection,
// else latest RXR.NF non-final), so it matches the doc the AI actually read.
//
// Requires POSTGRES_URL. Run from the uspto-search folder:
//     node oameta.mjs --limit 200
import { sql } from '@vercel/postgres';
import { getNircFinalOaNeedingMeta, setNircOaMeta, countNircFinalOaNeedingMeta } from './lib/db.js';

if (!process.env.POSTGRES_URL) {
  console.error('POSTGRES_URL is not set. Load it from grounds-secrets.env first.');
  process.exit(1);
}
const args = process.argv.slice(2);
const li = args.indexOf('--limit');
const LIMIT = li >= 0 ? Number(args[li + 1]) : 40;
const SITE = 'https://andy-ong.com';
const parseISO = (s) => { const m = String(s || '').match(/(\d{4})-?(\d{2})-?(\d{2})/); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : NaN; };

// Same rule as oa-fetch.mjs pickAction.
function pickAction(docs) {
  const acts = docs
    .filter((d) => d.code === 'RXFR..' || d.code === 'RXR.NF')
    .filter((d) => !isNaN(parseISO(d.date)))
    .sort((a, b) => parseISO(a.date) - parseISO(b.date));
  const finals = acts.filter((d) => d.code === 'RXFR..');
  const pool = finals.length ? finals : acts;
  return pool.length ? pool[pool.length - 1] : null;
}

const rows = await getNircFinalOaNeedingMeta(LIMIT);
let done = 0, failed = 0, noact = 0;
for (const r of rows) {
  try {
    const res = await fetch(`${SITE}/api/application?appNum=${r.application_number}&section=documents`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const bag = (await res.json()).documentBag || [];
    const docs = bag.map((d) => ({ id: d.documentIdentifier, code: (d.documentCode || '').toUpperCase(), date: (d.officialDate || '').slice(0, 10) }));
    const act = pickAction(docs);
    if (!act) { noact++; console.error(`  ${r.application_number}: no RXFR../RXR.NF action found`); continue; }
    await setNircOaMeta(r.application_number, act.id, act.date, act.code);
    done++;
    if (done % 25 === 0) console.log(`  …${done}`);
  } catch (e) { failed++; console.error(`  ${r.application_number}: ${e.message}`); }
}
console.log(`Filled ${done} (${failed} failed, ${noact} no-action). ${await countNircFinalOaNeedingMeta()} still missing OA meta.`);
try { await sql.end(); } catch { /* already closed */ }
