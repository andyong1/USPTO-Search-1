// Upload the opposition-target pass (produced per petopp-verify.md) into
// reexam_petition_opposition, and report how the read compares with the timing
// window that stands in for it — including how many oppositions name a paper
// that is NOT in the wrapper, which is the finding this pass exists to surface.
//
//     set -a && . ./grounds-secrets.env && set +a && node petopp-upload.mjs [--dir NAME]

import { sql } from '@vercel/postgres';
import { setPetitionOppositionSubject, countOppositionsNeedingSubject } from './lib/db.js';
import { requireEnv, argStr, retry, manifestByDocId, readJsonl, archiveJsonl, closeDb } from './lib/pipeline.mjs';

requireEnv('POSTGRES_URL');
const DIR = `snq-cumulative/${argStr('--dir', 'petopp-prod')}`;
const IN = `${DIR}/petopp-out.jsonl`;

const PARTY = new Set(['patent_owner', 'third_party_requester', 'unclear']);
const clean = (v) => v == null ? '' : String(v).replace(/\s+/g, ' ').trim();
// A date the AI read off the paper. Anything that is not a plain ISO date is
// dropped rather than coerced: a half-parsed date would silently mispair, which
// is the exact failure this pass is fixing.
const isoDate = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(clean(v)) ? clean(v) : null);

const byDoc = await manifestByDocId(DIR);
if (!byDoc.size) { console.error('No manifest.json — run petopp-fetch.mjs first.'); process.exit(1); }

const { rows: parsed, bad: unparseable } = await readJsonl(IN, 'run the AI pass per petopp-verify.md first.');

const NOT_OPP_NOTE = /^\s*not an opposition/i;

let uploaded = 0, bad = unparseable, nonOpp = 0, dated = 0, undatedRead = 0;
const partyTally = {}, confTally = {};
const rows = [];
for (const o of parsed) {
  const docId = clean(o.doc_id);
  const m = byDoc.get(docId);
  if (!m) { bad++; console.error('  not in manifest:', docId || JSON.stringify(o).slice(0, 60)); continue; }

  const party = PARTY.has(clean(o.party)) ? clean(o.party) : 'unclear';
  const conf = clean(o.confidence).toLowerCase() || null;
  const note = clean(o.note).slice(0, 200) || null;
  const badDate = clean(o.opposes_date) && !isoDate(o.opposes_date);
  if (badDate) console.error(`  ${docId}: unparseable opposes_date "${clean(o.opposes_date)}" — dropped`);
  const opposesDate = isoDate(o.opposes_date);
  const isOpp = !(o.is_opposition === false || NOT_OPP_NOTE.test(note || ''));
  if (!isOpp) nonOpp++;
  if (opposesDate) dated++; else if (isOpp) undatedRead++;

  await retry(docId, () => setPetitionOppositionSubject(docId, m.application_number, {
    party,
    opposes_date: opposesDate,
    opposes_verbatim: clean(o.opposes_verbatim).slice(0, 300),
    is_opposition: isOpp,
    confidence: conf,
    note,
  }));
  uploaded++;
  if (isOpp) {
    partyTally[party] = (partyTally[party] || 0) + 1;
    confTally[conf || 'none'] = (confTally[conf || 'none'] || 0) + 1;
    rows.push({ docId, app: m.application_number, opposesDate });
  }
}

await archiveJsonl(IN);
console.log(`\nDone. ${uploaded} document(s) uploaded; ${bad} rejected.`);
console.log(`  not oppositions at all: ${nonOpp}`);
console.log(`  target date read: ${dated} | target named but undated: ${undatedRead}`);
console.log('party:', JSON.stringify(partyTally), '| confidence:', JSON.stringify(confTally));

// The payoff: how many stated targets actually exist as a petition we harvested.
// A miss is not an error, but it has TWO very different causes and this report
// must not assert either one:
//   - the opposed paper was never entered into the wrapper (90/015,704), or
//   - it is on the docket that day under a code the classifier does not read as
//     a petition. Checking the first batch, RXLET. and SES.REQ.PC both carried
//     real patent owner petitions, which is a harvest gap rather than a missing
//     paper.
// So the miss is reported as "no petition-coded document on that date" and left
// for a person to resolve.
if (rows.length) {
  const withDate = rows.filter((r) => r.opposesDate);
  let hit = 0;
  const misses = [];
  for (const r of withDate) {
    const { rows: q } = await retry('match', () => sql`
      SELECT 1 FROM reexam_petition_docs
      WHERE application_number = ${r.app} AND kind = 'petition'
        AND substring(official_date::text, 1, 10) = ${r.opposesDate} LIMIT 1`);
    if (q.length) hit++; else misses.push(`${r.app}→${r.opposesDate}`);
  }
  console.log(`\nstated target present as a harvested petition: ${hit}/${withDate.length}`);
  if (misses.length) {
    console.log(`no petition-coded document on the stated date (${misses.length}) — check each:`);
    console.log('  either the paper was never entered into the wrapper, or it is on the');
    console.log('  docket under a code the classifier does not read as a petition.');
    for (const m of misses.slice(0, 25)) console.log(`  ${m}`);
  }
}

console.log(`\n${await retry('left', () => countOppositionsNeedingSubject()).catch(() => '?')} opposition(s) still awaiting extraction.`);
await closeDb(sql);
