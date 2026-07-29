// USITC Section 337 tracker — Phase 2c holding-SUMMARY upload (local).
//
// Reads itc-work/summary-work/itc-summary-out.jsonl (produced per itc-summary.md)
// and writes each investigation's plain-English holding summary to Neon
// (itc_outcome.ai_summary), versioned at SUMMARY_AI_V. Companion: itc-summary-fetch.mjs.
//
// Requires POSTGRES_URL (+ NODE_OPTIONS=--use-system-ca). Load grounds-secrets.env first.
//   node itc-summary-upload.mjs

import { readFile } from 'node:fs/promises';
import { setSummary, countInvestigationsToSummarize, SUMMARY_AI_V } from './lib/itc-db.js';
import { loadCatalogMaps, publishInvestigationDocs } from './lib/itc-publish.js';

if (!process.env.POSTGRES_URL) { console.error('POSTGRES_URL is not set. Load grounds-secrets.env first.'); process.exit(1); }

const FILE = 'itc-work/summary-work/itc-summary-out.jsonl';
let raw;
try { raw = await readFile(FILE, 'utf-8'); }
catch { console.error(`Not found: ${FILE}. Stage with itc-summary-fetch.mjs and summarize per itc-summary.md first.`); process.exit(1); }

const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean);
let ok = 0, bad = 0; const errs = []; const touched = [];
for (const line of lines) {
  let o;
  try { o = JSON.parse(line); }
  catch { bad++; if (errs.length < 10) errs.push({ line: line.slice(0, 80), error: 'invalid JSON' }); continue; }
  const number = String(o.investigation_number || '').trim();
  if (!/^337-\d+$/.test(number)) { bad++; if (errs.length < 10) errs.push({ number, error: 'bad investigation_number' }); continue; }
  const summary = o.summary ? String(o.summary).slice(0, 1500) : null;
  if (!summary) { bad++; if (errs.length < 10) errs.push({ number, error: 'empty summary' }); continue; }
  try { await setSummary(number, summary, SUMMARY_AI_V); ok++; touched.push(number); }
  catch (e) { bad++; if (errs.length < 10) errs.push({ number, error: String((e && e.message) || e) }); }
}

// Republish the touched investigations' detail blobs so the holding summary shows
// on the detail page (the main projection is refreshed via edis-upload --publish-only).
if (touched.length && process.env.BLOB_READ_WRITE_TOKEN) {
  let metaByNumber = new Map();
  try { ({ metaByNumber } = await loadCatalogMaps('itc-work')); } catch { /* header meta optional */ }
  let rp = 0;
  for (const number of touched) {
    try { await publishInvestigationDocs(number, metaByNumber.get(number)); rp++; }
    catch (e) { if (errs.length < 15) errs.push({ number, error: `republish: ${(e && e.message) || e}` }); }
  }
  console.log(`Republished ${rp} detail blob(s) with holding summaries.`);
}

if (errs.length) console.log('Issues:', errs);
const remaining = await countInvestigationsToSummarize(SUMMARY_AI_V);
console.log(`Uploaded ${ok} summary(ies), ${bad} skipped. ${remaining} investigation(s) still awaiting a summary at v${SUMMARY_AI_V}.`);
