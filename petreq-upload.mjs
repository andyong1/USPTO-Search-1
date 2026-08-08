// Upload the as-filed relief pass (produced per petreq-verify.md) into
// reexam_petition_request, validating against the controlled vocabulary, and
// report how often the petitioner's framing matches the Office's later
// characterization (reexam_petition_subject) for the petitions where both exist.
//
//     set -a && . ./grounds-secrets.env && set +a && node petreq-upload.mjs [--dir NAME]

import { readFile, rename } from 'node:fs/promises';
import { sql } from '@vercel/postgres';
import { setPetitionRequestSubject, countPetitionsNeedingRequestSubject } from './lib/db.js';

if (!process.env.POSTGRES_URL) { console.error('POSTGRES_URL is not set.'); process.exit(1); }
const args = process.argv.slice(2);
const di = args.indexOf('--dir');
const DIR = `snq-cumulative/${di >= 0 ? args[di + 1] : 'petreq-prod'}`;
const IN = `${DIR}/petreq-out.jsonl`;

const RELIEFS = new Set(['extension_of_time', 'vacate_or_terminate_proceeding', 'reconsider_snq_or_order',
  'withdraw_finality', 'waiver_or_suspension_of_rule', 'matters_not_provided_for', 'supervisory_review',
  'expunge_or_strike_paper', 'concurrent_proceedings_or_stay', 'interview_request',
  'entry_of_papers_or_amendment', 'filing_date_or_fee_or_defective_request', 'revival_or_abandonment',
  'correct_certificate_or_inventorship', 'withdraw_as_attorney', 'other']);
const PARTY = new Set(['patent_owner', 'third_party_requester', 'unclear']);
const clean = (v) => v == null ? '' : String(v).replace(/\s+/g, ' ').trim();
const arr = (v) => Array.isArray(v) ? v.map(clean).filter(Boolean) : [];

// Same transient-connection guard as petreq-fetch.mjs.
async function retry(label, fn, attempts = 4) {
  for (let i = 1; ; i++) {
    try { return await fn(); }
    catch (e) {
      const transient = /ECONNRESET|fetch failed|ETIMEDOUT|socket hang up/i.test(String(e.message || e));
      if (!transient || i >= attempts) throw e;
      const wait = 1500 * i;
      console.log(`  ${label}: transient DB error (attempt ${i}/${attempts}), retrying in ${wait}ms…`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

let manifest;
try { manifest = JSON.parse(await readFile(`${DIR}/manifest.json`, 'utf-8')); }
catch { console.error('No manifest.json — run petreq-fetch.mjs first.'); process.exit(1); }
const byDoc = new Map(manifest.map((m) => [m.doc_id, m]));

let raw;
try { raw = await readFile(IN, 'utf-8'); }
catch { console.error(`No ${IN} — run the AI pass per petreq-verify.md first.`); process.exit(1); }

// A document filed under a petition code but which is not itself a request for
// relief (an exhibit, a standalone opposition, an Office paper). The classifiers
// signal these per petreq-verify.md with reliefs=["other"] + low confidence, and
// a note beginning "Not a petition:" / "Plainly an opposition:". Both signals are
// required: a genuine petition can legitimately have relief "other", and a real
// petition may merely mention an opposition.
const NOT_PET_NOTE = /^\s*(not a petition|plainly an opposition|not itself a petition)/i;
const isNonPetition = (reliefs, conf, note) =>
  reliefs.length === 1 && reliefs[0] === 'other' && conf === 'low' && NOT_PET_NOTE.test(note || '');

let uploaded = 0, bad = 0, nonPetitions = 0;
const reliefTally = {}, partyTally = {}, confTally = {};
for (const line of raw.split(/\r?\n/)) {
  if (!line.trim()) continue;
  let o;
  try { o = JSON.parse(line); } catch { bad++; continue; }
  const docId = clean(o.doc_id);
  const m = byDoc.get(docId);
  if (!m) { bad++; console.error('  not in manifest:', docId || line.slice(0, 60)); continue; }

  const reliefs = arr(o.reliefs).filter((r) => RELIEFS.has(r));
  const unknown = arr(o.reliefs).filter((r) => !RELIEFS.has(r));
  if (unknown.length) console.error(`  ${docId}: unknown relief dropped: ${unknown.join(', ')}`);
  let primary = clean(o.primary_relief);
  if (!RELIEFS.has(primary)) { if (primary) console.error(`  ${docId}: bad primary_relief "${primary}"`); primary = reliefs[0] || 'other'; }
  const party = PARTY.has(clean(o.petitioner)) ? clean(o.petitioner) : 'unclear';
  const conf = clean(o.confidence).toLowerCase() || null;
  const note = clean(o.note).slice(0, 200) || null;
  const finalReliefs = reliefs.length ? reliefs : [primary];
  const nonPet = isNonPetition(finalReliefs, conf, note);
  if (nonPet) nonPetitions++;

  await retry(docId, () => setPetitionRequestSubject(docId, m.application_number, {
    reliefs: finalReliefs,
    primary_relief: primary,
    rules: arr(o.rules).slice(0, 25),
    statutes: arr(o.statutes).slice(0, 25),
    petitioner: party,
    relief_verbatim: clean(o.relief_verbatim).slice(0, 300),
    confidence: conf,
    note,
    is_petition: !nonPet,
  }));
  uploaded++;
  // Non-petitions are excluded from the relief distribution — counting exhibits
  // as "other" relief would badly skew it.
  if (!nonPet) {
    for (const r of finalReliefs) reliefTally[r] = (reliefTally[r] || 0) + 1;
    partyTally[party] = (partyTally[party] || 0) + 1;
    confTally[conf || 'none'] = (confTally[conf || 'none'] || 0) + 1;
  }
}

try { await rename(IN, IN.replace(/\.jsonl$/, `.${Date.now()}.done.jsonl`)); } catch { /* best-effort */ }
console.log(`\nDone. ${uploaded} document(s) uploaded; ${bad} rejected.`);
console.log(`  of those, ${nonPetitions} are NOT petitions (exhibits / oppositions / Office papers) — flagged is_petition=false and excluded from the stats below.`);
console.log(`  genuine petitions: ${uploaded - nonPetitions}`);
console.log('\nrelief AS FILED (multi-label, genuine petitions only):');
for (const [k, v] of Object.entries(reliefTally).sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(4)}  ${k}`);
console.log('\npetitioner:', JSON.stringify(partyTally), '| confidence:', JSON.stringify(confTally));

// Cross-check: petitioner's framing vs the Office's characterization, for the
// petitions where a decision was also classified. Divergence is a finding, not a
// bug — the Office sometimes treats a paper as different relief than styled.
const cmp = await retry('compare', () => sql`
  SELECT r.primary_relief AS filed, s.primary_relief AS office, count(*)::int AS n
  FROM reexam_petition_request r
  JOIN reexam_petition_docs pd ON pd.doc_id = r.doc_id
  JOIN reexam_petition_subject s ON s.application_number = pd.application_number
  WHERE r.primary_relief IS NOT NULL AND s.primary_relief IS NOT NULL
  GROUP BY 1, 2 ORDER BY n DESC`);
const agree = cmp.rows.filter((x) => x.filed === x.office).reduce((a, b) => a + b.n, 0);
const total = cmp.rows.reduce((a, b) => a + b.n, 0);
console.log(`\nas-filed vs Office characterization (same proceeding): ${agree}/${total} agree` + (total ? ` (${Math.round(agree / total * 100)}%)` : ''));
console.log('top divergences (petitioner framing → Office characterization):');
for (const x of cmp.rows.filter((y) => y.filed !== y.office).slice(0, 12)) console.log(`  ${String(x.n).padStart(3)}  ${x.filed}  →  ${x.office}`);

console.log(`\n${await retry('left', () => countPetitionsNeedingRequestSubject()).catch(() => '?')} petition(s) still awaiting extraction.`);
try { await sql.end(); } catch { /* */ }
