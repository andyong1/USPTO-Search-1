// USITC Section 337 tracker — Phase 2 AI-classify UPLOAD (local).
//
// Reads the classifier output (itc-work/outcome-work/itc-outcome-out.jsonl,
// produced per itc-outcome.md) and writes each investigation's outcome to Neon
// (itc_outcome), versioned at OUTCOME_AI_V. Companion: itc-outcome-fetch.mjs.
//
// Requires POSTGRES_URL (+ NODE_EXTRA_CA_CERTS). Load grounds-secrets.env first.
//   node itc-outcome-upload.mjs

import { readFile } from 'node:fs/promises';
import { setOutcome, countInvestigationsToClassify } from './lib/itc-db.js';
import { OUTCOME_AI_V } from './lib/itc-outcome.js';

if (!process.env.POSTGRES_URL) { console.error('POSTGRES_URL is not set. Load grounds-secrets.env first.'); process.exit(1); }

const FILE = 'itc-work/outcome-work/itc-outcome-out.jsonl';
const DISPOSITIONS = new Set(['violation_found', 'no_violation', 'terminated_settlement', 'terminated_consent', 'terminated_default', 'terminated_withdrawal', 'terminated_arbitration', 'terminated_other', 'pending']);
const VIOLATIONS = new Set(['full', 'partial', 'none']);
const REMEDIES = new Set(['LEO', 'GEO', 'CDO']);
const ACTIONS = new Set(['affirmed', 'reversed', 'modified', 'affirmed_in_part', 'not_reviewed']);
const CONF = new Set(['high', 'medium', 'low']);
const clean = (v, set) => (v && set.has(v) ? v : null);

let raw;
try { raw = await readFile(FILE, 'utf-8'); }
catch { console.error(`Not found: ${FILE}. Stage with itc-outcome-fetch.mjs and classify per itc-outcome.md first.`); process.exit(1); }

const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean);
let ok = 0, bad = 0; const errs = [];
for (const line of lines) {
  let o;
  try { o = JSON.parse(line); }
  catch (e) { bad++; if (errs.length < 10) errs.push({ line: line.slice(0, 80), error: 'invalid JSON' }); continue; }
  const number = String(o.investigation_number || '').trim();
  if (!/^337-\d+$/.test(number)) { bad++; if (errs.length < 10) errs.push({ number, error: 'bad investigation_number' }); continue; }
  const remedies = Array.isArray(o.remedies) ? [...new Set(o.remedies.filter((r) => REMEDIES.has(r)))] : [];
  const sourceDocs = Array.isArray(o.source_docs) ? o.source_docs.map(String).filter(Boolean) : [];
  try {
    await setOutcome(number, {
      disposition: clean(o.disposition, DISPOSITIONS),
      violation: clean(o.violation, VIOLATIONS),
      remedies,
      commissionAction: clean(o.commission_action, ACTIONS),
      confidence: clean(o.confidence, CONF),
      note: o.note ? String(o.note).slice(0, 600) : null,
      sourceDocs,
    }, OUTCOME_AI_V);
    ok++;
  } catch (e) { bad++; if (errs.length < 10) errs.push({ number, error: String((e && e.message) || e) }); }
}

if (errs.length) console.log('Issues:', errs);
const remaining = await countInvestigationsToClassify(OUTCOME_AI_V);
console.log(`Uploaded ${ok} outcome(s), ${bad} skipped. ${remaining} investigation(s) still awaiting classification at v${OUTCOME_AI_V}.`);
