// Upload the petition subject-matter pass (produced per petsubj-verify.md) into
// reexam_petition_subject. Validates every relief against the controlled
// vocabulary so a typo can't silently create a new filter facet, and reports the
// blind cross-check between the AI's reading of the text and the USPTO doc code.
//
//     set -a && . ./grounds-secrets.env && set +a && node petsubj-upload.mjs [--dir NAME]

import { readFile, rename } from 'node:fs/promises';
import { sql } from '@vercel/postgres';
import { setPetitionSubject, countDecisionsNeedingSubject } from './lib/db.js';

if (!process.env.POSTGRES_URL) { console.error('POSTGRES_URL is not set.'); process.exit(1); }
const args = process.argv.slice(2);
const di = args.indexOf('--dir');
const DIR = `snq-cumulative/${di >= 0 ? args[di + 1] : 'petsubj-prod'}`;
const IN = `${DIR}/petsubj-out.jsonl`;

const RELIEFS = new Set(['extension_of_time', 'vacate_or_terminate_proceeding', 'reconsider_snq_or_order',
  'withdraw_finality', 'waiver_or_suspension_of_rule', 'matters_not_provided_for', 'supervisory_review',
  'expunge_or_strike_paper', 'concurrent_proceedings_or_stay', 'interview_request',
  'entry_of_papers_or_amendment', 'filing_date_or_fee_or_defective_request', 'revival_or_abandonment',
  'correct_certificate_or_inventorship', 'withdraw_as_attorney', 'other']);
const OUTCOMES = new Set(['granted', 'granted_in_part', 'dismissed', 'denied', 'undecided', 'other']);
const WAIVER = new Set(['granted', 'granted_in_part', 'dismissed', 'denied']);
const PARTY = new Set(['patent_owner', 'third_party_requester', 'unclear']);
const clean = (v) => v == null ? '' : String(v).replace(/\s+/g, ' ').trim();
const arr = (v) => Array.isArray(v) ? v.map(clean).filter(Boolean) : [];

let manifest;
try { manifest = JSON.parse(await readFile(`${DIR}/manifest.json`, 'utf-8')); }
catch { console.error('No manifest.json — run petsubj-fetch.mjs first.'); process.exit(1); }
const byDoc = new Map(manifest.map((m) => [m.doc_id, m]));

let raw;
try { raw = await readFile(IN, 'utf-8'); }
catch { console.error(`No ${IN} — run the AI pass per petsubj-verify.md first.`); process.exit(1); }

let uploaded = 0, bad = 0, agree = 0, partial = 0;
const mismatches = [], reliefTally = {}, meritsTally = {};
for (const line of raw.split(/\r?\n/)) {
  if (!line.trim()) continue;
  let o;
  try { o = JSON.parse(line); } catch { bad++; continue; }
  const docId = clean(o.doc_id);
  const m = byDoc.get(docId);
  if (!m) { bad++; console.error('  not in manifest:', docId || line.slice(0, 60)); continue; }

  const reliefs = arr(o.reliefs).filter((r) => RELIEFS.has(r));
  const unknown = arr(o.reliefs).filter((r) => !RELIEFS.has(r));
  if (unknown.length) console.error(`  ${docId}: unknown relief value(s) dropped: ${unknown.join(', ')}`);
  let primary = clean(o.primary_relief);
  if (!RELIEFS.has(primary)) { if (primary) console.error(`  ${docId}: bad primary_relief "${primary}" → other`); primary = reliefs[0] || 'other'; }
  const merits = OUTCOMES.has(clean(o.merits_outcome)) ? clean(o.merits_outcome) : 'other';
  const waiver = WAIVER.has(clean(o.ancillary_waiver)) ? clean(o.ancillary_waiver) : null;
  const party = PARTY.has(clean(o.petitioner)) ? clean(o.petitioner) : 'unclear';

  // Where the § 325(d) question was referred to the CRU, the petition is granted
  // (leave to file) and granted_relief records which relief that was — see
  // petsubj-verify.md. Guarded so a stale spec can't reintroduce "deferred".
  const referred = o.referred_to_cru === true;
  const grantedRelief = RELIEFS.has(clean(o.granted_relief)) ? clean(o.granted_relief)
    : (referred ? 'waiver_or_suspension_of_rule' : null);

  await setPetitionSubject(docId, m.application_number, {
    reliefs: reliefs.length ? reliefs : [primary],
    primary_relief: primary,
    merits_outcome: referred && merits === 'undecided' ? 'granted' : merits,
    ancillary_waiver: waiver,
    granted_relief: grantedRelief,
    referred_to_cru: referred,
    rules: arr(o.rules).slice(0, 25),
    statutes: arr(o.statutes).slice(0, 25),
    petitioner: party,
    relief_verbatim: clean(o.relief_verbatim).slice(0, 300),
    confidence: clean(o.confidence).toLowerCase() || null,
    note: clean(o.note).slice(0, 200) || null,
  });
  uploaded++;
  for (const r of (reliefs.length ? reliefs : [primary])) reliefTally[r] = (reliefTally[r] || 0) + 1;
  meritsTally[merits] = (meritsTally[merits] || 0) + 1;

  // Blind cross-check: the AI never saw code_outcome.
  const code = clean(m.code_outcome), txt = merits;
  if (code === txt) agree++;
  else if ((code === 'granted' && txt === 'granted_in_part') || (code === 'granted_in_part' && txt === 'granted')) partial++;
  else if (!(code === 'dismissed' && txt === 'denied') && !(code === 'denied' && txt === 'dismissed')) {
    mismatches.push(`${m.application_number} (${m.doc_code}): code=${code} vs merits=${txt}`);
  }
}

try { await rename(IN, IN.replace(/\.jsonl$/, `.${Date.now()}.done.jsonl`)); } catch { /* best-effort */ }
console.log(`\nDone. ${uploaded} decision(s) uploaded; ${bad} rejected.`);
console.log('\nrelief distribution (multi-label, so counts exceed decisions):');
for (const [k, v] of Object.entries(reliefTally).sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(4)}  ${k}`);
console.log('\nmerits outcome:', JSON.stringify(meritsTally));
console.log(`\ncross-check vs USPTO doc code: ${agree} exact, ${partial} full-vs-partial-grant, ${mismatches.length} differing`);
console.log('  (differences are expected where the code reflects an ancillary grant but the MERITS ask was dismissed)');
for (const x of mismatches.slice(0, 25)) console.log('   ', x);
if (mismatches.length > 25) console.log(`    … +${mismatches.length - 25} more`);
console.log(`\n${await countDecisionsNeedingSubject()} decision(s) still awaiting classification.`);
try { await sql.end(); } catch { /* */ }
