// Proper as-filed vs Office-characterization agreement, measured at the THREAD
// level: a petition is compared only with the decision that actually resolved
// IT (via threadPetitions), not with any decision that happens to share the
// control number. The naive same-proceeding join in petreq-upload.mjs produces a
// cross-product when a proceeding has several petitions and several decisions,
// which manufactures false divergences.
//     set -a && . ./grounds-secrets.env && set +a && node petreq-agree.mjs

import { sql } from '@vercel/postgres';
import { listPetitionTrailDocs } from './lib/db.js';
import { threadPetitions } from './lib/petitions.js';

const all = await listPetitionTrailDocs();
// Drop documents that aren't petitions (exhibits / oppositions / Office papers),
// exactly as the API does before threading.
const docs = all.filter((d) => !(d.kind === 'petition' && d.req_is_petition === false));

const byApp = new Map();
for (const d of docs) {
  if (!byApp.has(d.application_number)) byApp.set(d.application_number, []);
  byApp.get(d.application_number).push(d);
}

let paired = 0, agree = 0, filedOnly = 0, officeOnly = 0, neither = 0;
const div = {};
for (const [, rows] of byApp) {
  for (const t of threadPetitions(rows)) {
    const filed = t.petition && t.petition.req_primary_relief;
    const office = t.decision && t.decision.primary_relief;
    if (filed && office) {
      paired++;
      if (filed === office) agree++;
      else div[`${filed} → ${office}`] = (div[`${filed} → ${office}`] || 0) + 1;
    } else if (filed) filedOnly++;
    else if (office) officeOnly++;
    else neither++;
  }
}

console.log('=== thread-level comparison (petition paired with ITS decision) ===');
console.log(`  both readings present: ${paired}`);
console.log(`  AGREE on the substantive ask: ${agree}/${paired}` + (paired ? ` (${Math.round(agree / paired * 100)}%)` : ''));
console.log(`  divergent: ${paired - agree}`);
console.log('\n=== coverage of threads ===');
console.log(`  as-filed only (no decision yet — relief that did not exist before): ${filedOnly}`);
console.log(`  Office only (decision on file, petition paper not separately staged): ${officeOnly}`);
console.log(`  neither classified: ${neither}`);
console.log('\n=== divergences (petitioner framing → Office characterization) ===');
for (const [k, v] of Object.entries(div).sort((a, b) => b[1] - a[1]).slice(0, 15)) console.log(`  ${String(v).padStart(3)}  ${k}`);
try { await sql.end(); } catch { /* */ }
