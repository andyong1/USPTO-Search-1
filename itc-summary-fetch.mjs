// USITC Section 337 tracker — Phase 2c holding-SUMMARY staging (local).
//
// Stages each investigation's extracted dispositive text (from itc_doc_text) into
// a work folder + manifest for the local Claude session, which reads them and
// writes a plain-English "what the Commission held" blurb to itc-summary-out.jsonl
// (see itc-summary.md). Companion: itc-summary-upload.mjs. Independent of the
// outcome pass (own summary_ai_v gate) so summaries can backfill separately.
//
// Requires POSTGRES_URL (+ NODE_OPTIONS=--use-system-ca). Load grounds-secrets.env first.
//   node itc-summary-fetch.mjs             # stage all pending (up to --limit)
//   node itc-summary-fetch.mjs --limit 40
//   node itc-summary-fetch.mjs --inv 337-1000
//
// Then: summarize per itc-summary.md -> itc-summary-out.jsonl -> node itc-summary-upload.mjs

import { mkdir, writeFile, rm } from 'node:fs/promises';
import { investigationsToSummarize, dispositiveTextForInvestigation, countInvestigationsToSummarize, SUMMARY_AI_V } from './lib/itc-db.js';

if (!process.env.POSTGRES_URL) { console.error('POSTGRES_URL is not set. Load grounds-secrets.env first.'); process.exit(1); }

const args = process.argv.slice(2);
const INV = args.includes('--inv') ? args[args.indexOf('--inv') + 1] : null;
const LIMIT = args.includes('--limit') ? Number(args[args.indexOf('--limit') + 1]) : 40;

const DIR = 'itc-work/summary-work';
await rm(DIR, { recursive: true, force: true });
await mkdir(DIR, { recursive: true });

const roleLabel = {
  opinion: 'COMMISSION OPINION', final_id: 'FINAL INITIAL DETERMINATION (ALJ)',
  remedy_order: 'COMMISSION ORDER (REMEDY)', consent_order: 'CONSENT ORDER',
  commission_order: 'COMMISSION ORDER', commission_notice: 'COMMISSION NOTICE',
  partial_id: 'INITIAL DETERMINATION (OTHER THAN FINAL)',
};

const targets = await investigationsToSummarize(LIMIT, SUMMARY_AI_V, INV);
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

const remaining = await countInvestigationsToSummarize(SUMMARY_AI_V);
console.log(`Staged ${manifest.length} investigation(s) in ${DIR} (${remaining} total awaiting a summary at v${SUMMARY_AI_V}).`);
console.log(manifest.length ? 'Next: summarize per itc-summary.md -> itc-summary-out.jsonl -> node itc-summary-upload.mjs' : 'Nothing to summarize.');
