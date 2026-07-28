// USITC Section 337 tracker — Phase 2 AI-classify STAGING (local).
//
// Stages each investigation's extracted dispositive text (from itc_doc_text) into
// a work folder + manifest for the nightly local Claude session, which reads them
// and writes itc-outcome-out.jsonl (see itc-outcome.md). Companion:
// itc-outcome-upload.mjs. The heuristic outcome is deliberately NOT staged so the
// AI read is independent.
//
// Requires POSTGRES_URL (+ NODE_EXTRA_CA_CERTS). Load grounds-secrets.env first.
//   node itc-outcome-fetch.mjs             # stage all pending (up to --limit)
//   node itc-outcome-fetch.mjs --limit 40  # default batch cap is 40
//   node itc-outcome-fetch.mjs --inv 337-1000
//
// Then: classify per itc-outcome.md -> itc-work/outcome-work/itc-outcome-out.jsonl
//       -> node itc-outcome-upload.mjs

import { mkdir, writeFile, rm } from 'node:fs/promises';
import { investigationsToClassify, dispositiveTextForInvestigation, countInvestigationsToClassify } from './lib/itc-db.js';
import { OUTCOME_AI_V } from './lib/itc-outcome.js';

if (!process.env.POSTGRES_URL) { console.error('POSTGRES_URL is not set. Load grounds-secrets.env first.'); process.exit(1); }

const args = process.argv.slice(2);
const INV = args.includes('--inv') ? args[args.indexOf('--inv') + 1] : null;
const LIMIT = args.includes('--limit') ? Number(args[args.indexOf('--limit') + 1]) : 40;

const DIR = 'itc-work/outcome-work';
await rm(DIR, { recursive: true, force: true });
await mkdir(DIR, { recursive: true });

const roleLabel = {
  opinion: 'COMMISSION OPINION', final_id: 'FINAL INITIAL DETERMINATION (ALJ)',
  remedy_order: 'COMMISSION ORDER (REMEDY)', consent_order: 'CONSENT ORDER',
  commission_order: 'COMMISSION ORDER', commission_notice: 'COMMISSION NOTICE',
  partial_id: 'INITIAL DETERMINATION (OTHER THAN FINAL)',
};

const targets = await investigationsToClassify(LIMIT, OUTCOME_AI_V, INV);
const manifest = [];
for (const number of targets) {
  const docs = await dispositiveTextForInvestigation(number);
  if (!docs.length) continue;
  const parts = [`INVESTIGATION: ${number}`, ''];
  for (const d of docs) {
    parts.push(`===== [${roleLabel[d.doc_role] || d.doc_role || 'DOCUMENT'}] ${d.document_title || ''} (${d.received_date || 'n.d.'}) · docId ${d.doc_id} =====`);
    parts.push(d.text || '');
    parts.push('');
  }
  await writeFile(`${DIR}/${number}.txt`, parts.join('\n'), 'utf-8');
  manifest.push({ investigation_number: number, docs: docs.map((d) => ({ docId: d.doc_id, role: d.doc_role, title: d.document_title, date: d.received_date })), chars: docs.reduce((s, d) => s + (d.text ? d.text.length : 0), 0) });
}
await writeFile(`${DIR}/manifest.json`, JSON.stringify(manifest, null, 1), 'utf-8');

const remaining = await countInvestigationsToClassify(OUTCOME_AI_V);
console.log(`Staged ${manifest.length} investigation(s) in ${DIR} (${remaining} total awaiting classification at v${OUTCOME_AI_V}).`);
console.log(manifest.length ? 'Next: classify per itc-outcome.md -> itc-outcome-out.jsonl -> node itc-outcome-upload.mjs' : 'Nothing to classify.');
