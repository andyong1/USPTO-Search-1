// Deterministic (no AI): count the Office actions issued before each NIRC —
// final rejections (RXFR..) + non-final actions (RXR.NF) with an official date
// on/before the NIRC date — and store it as reexam_nirc_art.oa_count for the
// /reexam-nirc "No. of Office Actions" column. Zero when none.
//
// Requires POSTGRES_URL. Run from the uspto-search folder:
//     node oacount.mjs             # default 40
//     node oacount.mjs --limit 600 # full set
import { sql } from '@vercel/postgres';
import { getNircNeedingOaCount, setNircOaCount, countNircNeedingOaCount } from './lib/db.js';

if (!process.env.POSTGRES_URL) {
  console.error('POSTGRES_URL is not set. Load it from grounds-secrets.env first.');
  process.exit(1);
}
const args = process.argv.slice(2);
const li = args.indexOf('--limit');
const LIMIT = li >= 0 ? Number(args[li + 1]) : 40;
const SITE = 'https://andy-ong.com';
const parseISO = (s) => { const m = String(s || '').match(/(\d{4})-?(\d{2})-?(\d{2})/); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : NaN; };

const rows = await getNircNeedingOaCount(LIMIT);
let done = 0, failed = 0;
for (const r of rows) {
  const nircMs = parseISO(r.nirc_date);
  try {
    const res = await fetch(`${SITE}/api/application?appNum=${r.application_number}&section=documents`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const bag = (await res.json()).documentBag || [];
    const n = bag.filter((d) => {
      const code = (d.documentCode || '').toUpperCase();
      if (code !== 'RXFR..' && code !== 'RXR.NF') return false;
      const t = parseISO(d.officialDate);
      return isNaN(nircMs) || isNaN(t) || t <= nircMs; // actions precede the NIRC
    }).length;
    await setNircOaCount(r.application_number, n);
    done++;
    if (done % 25 === 0) console.log(`  …${done}`);
  } catch (e) { failed++; console.error(`  ${r.application_number}: ${e.message}`); }
}
console.log(`Counted ${done} proceeding(s) (${failed} failed). ${await countNircNeedingOaCount()} still awaiting a count.`);
try { await sql.end(); } catch { /* already closed */ }
