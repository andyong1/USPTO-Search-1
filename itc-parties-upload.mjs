// USITC Section 337 tracker — Phase 2b PARTIES/PATENTS UPLOAD (local).
//
// Reads the extractor output (itc-work/parties-work/itc-parties-out.jsonl,
// produced per itc-parties.md) and writes each investigation's parties, asserted
// patents, accused products, and requested remedies to Neon (itc_parties),
// versioned at PARTIES_AI_V. Companion: itc-parties-fetch.mjs.
//
// Requires POSTGRES_URL (+ NODE_OPTIONS=--use-system-ca). Load grounds-secrets.env first.
//   node itc-parties-upload.mjs

import { readFile } from 'node:fs/promises';
import { setParties, countInvestigationsForParties, PARTIES_AI_V } from './lib/itc-db.js';

if (!process.env.POSTGRES_URL) { console.error('POSTGRES_URL is not set. Load grounds-secrets.env first.'); process.exit(1); }

const FILE = 'itc-work/parties-work/itc-parties-out.jsonl';
const REMEDIES = new Set(['LEO', 'GEO', 'CDO']);
const CONF = new Set(['high', 'medium', 'low']);
const clean = (v, set) => (v && set.has(v) ? v : null);
const strList = (a, cap = 40) => (Array.isArray(a) ? [...new Set(a.map((s) => String(s || '').trim()).filter(Boolean))].slice(0, cap) : []);
// Patent identifiers: keep digits/commas plus an optional design/reissue prefix.
const patList = (a) => strList(a).map((s) => s.replace(/^u\.?s\.?\s*patent\s*(no\.?)?\s*/i, '').replace(/[.;'"]+$/,'').trim())
  .filter((s) => /^(D|RE|PP|AI|T|H|X|RX)?\s?[\d,]{3,}$/i.test(s));

let raw;
try { raw = await readFile(FILE, 'utf-8'); }
catch { console.error(`Not found: ${FILE}. Stage with itc-parties-fetch.mjs and extract per itc-parties.md first.`); process.exit(1); }

const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean);
let ok = 0, bad = 0; const errs = [];
for (const line of lines) {
  let o;
  try { o = JSON.parse(line); }
  catch { bad++; if (errs.length < 10) errs.push({ line: line.slice(0, 80), error: 'invalid JSON' }); continue; }
  const number = String(o.investigation_number || '').trim();
  if (!/^337-\d+$/.test(number)) { bad++; if (errs.length < 10) errs.push({ number, error: 'bad investigation_number' }); continue; }
  try {
    await setParties(number, {
      complainants: strList(o.complainants),
      respondents: strList(o.respondents),
      assertedPatents: patList(o.asserted_patents),
      accusedProducts: o.accused_products ? String(o.accused_products).slice(0, 400) : null,
      requestedRemedies: Array.isArray(o.requested_remedies) ? [...new Set(o.requested_remedies.filter((r) => REMEDIES.has(r)))] : [],
      confidence: clean(o.confidence, CONF),
      note: o.note ? String(o.note).slice(0, 600) : null,
      sourceDoc: o.source_doc ? String(o.source_doc) : null,
    }, PARTIES_AI_V);
    ok++;
  } catch (e) { bad++; if (errs.length < 10) errs.push({ number, error: String((e && e.message) || e) }); }
}

if (errs.length) console.log('Issues:', errs);
const remaining = await countInvestigationsForParties(PARTIES_AI_V);
console.log(`Uploaded ${ok} parties record(s), ${bad} skipped. ${remaining} investigation(s) still awaiting extraction at v${PARTIES_AI_V}.`);
