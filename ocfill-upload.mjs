// Upload the NIRC claim-disposition fill (per ocfill-verify.md) into
// reexam_conclusions. Only fills blank fields — never clobbers a cert-derived
// outcome. Companion to ocfill-fetch.mjs.

import { readFile, rename } from 'node:fs/promises';
import { sql } from '@vercel/postgres';
import { setNircOutcome } from './lib/db.js';

if (!process.env.POSTGRES_URL) {
  console.error('POSTGRES_URL is not set. Load it from grounds-secrets.env first.');
  process.exit(1);
}

const DIR = 'snq-cumulative/oc-work';
const IN = `${DIR}/oc-out.jsonl`;
const clean = (v) => v == null ? '' : String(v).replace(/\s+/g, ' ').trim();

let known;
try { known = new Set(JSON.parse(await readFile(`${DIR}/manifest.json`, 'utf-8')).map((m) => m.application_number)); }
catch { console.error('No manifest.json — run ocfill-fetch.mjs first.'); process.exit(1); }

let raw;
try { raw = await readFile(IN, 'utf-8'); }
catch { console.error(`No ${IN} found — run ocfill-fetch.mjs and verify first.`); process.exit(1); }

let filled = 0, blankOut = 0, bad = 0;
for (const line of raw.split(/\r?\n/)) {
  if (!line.trim()) continue;
  let o;
  try { o = JSON.parse(line); } catch { bad++; continue; }
  const app = clean(o.application_number);
  if (!app || !known.has(app)) { bad++; console.error('  not in manifest:', app || line.slice(0, 60)); continue; }
  const summary = clean(o.summary).slice(0, 120);
  if (!summary) { blankOut++; continue; } // nothing extractable — leave blank
  await setNircOutcome(app, {
    summary,
    confirmed: clean(o.confirmed).slice(0, 120) || null,
    cancelled: clean(o.cancelled).slice(0, 120) || null,
    amended: clean(o.amended).slice(0, 120) || null,
    new: clean(o.new).slice(0, 120) || null,
  });
  filled++;
}

try { await rename(IN, IN.replace(/\.jsonl$/, `.${Date.now()}.done.jsonl`)); } catch { /* best-effort */ }
console.log(`Done. ${filled} outcome(s) filled from the NIRC, ${blankOut} left blank (no disposition), ${bad} rejected.`);
try { await sql.end(); } catch { /* already closed */ }
