// Upload the TRNA fallback requester pass (produced per trnaid-verify.md) into
// reexam_requester. Gap-fill only: setRequesterFromTrna is guarded so it never
// overwrites a name that is already present. Companion to trnaid-fetch.mjs.

import { readFile, rename } from 'node:fs/promises';
import { sql } from '@vercel/postgres';
import { setRequesterFromTrna } from './lib/db.js';

if (!process.env.POSTGRES_URL) {
  console.error('POSTGRES_URL is not set. Load it from grounds-secrets.env first.');
  process.exit(1);
}

const args = process.argv.slice(2);
const dirIdx = args.indexOf('--dir');
const DIR = `snq-cumulative/${dirIdx >= 0 ? args[dirIdx + 1] : 'trnaid-work'}`;
const IN = `${DIR}/trnaid-out.jsonl`;
const clean = (v) => v == null ? '' : String(v).replace(/\s+/g, ' ').trim();

let manifest;
try { manifest = JSON.parse(await readFile(`${DIR}/manifest.json`, 'utf-8')); }
catch { console.error('No manifest.json — run trnaid-fetch.mjs first.'); process.exit(1); }
const byApp = new Map(manifest.map((m) => [m.application_number, m]));

let raw;
try { raw = await readFile(IN, 'utf-8'); }
catch { console.error(`No ${IN} found — run trnaid-fetch.mjs and verify first.`); process.exit(1); }

let uploaded = 0, named = 0, bad = 0;
for (const line of raw.split(/\r?\n/)) {
  if (!line.trim()) continue;
  let o;
  try { o = JSON.parse(line); } catch { bad++; continue; }
  const app = clean(o.application_number);
  const entry = byApp.get(app);
  if (!app || !entry) { bad++; console.error('  not in manifest:', app || line.slice(0, 60)); continue; }
  const name = clean(o.requester_name).slice(0, 120);
  await setRequesterFromTrna(app, {
    requester_name: name || null,
    docId: entry.trna_doc_id || null,
    date: entry.trna_date || null,
    confidence: clean(o.confidence).toLowerCase() || null,
    note: clean(o.note).slice(0, 300) || 'from TRNA transmittal field',
  });
  uploaded++;
  if (name) named++;
}

try { await rename(IN, IN.replace(/\.jsonl$/, `.${Date.now()}.done.jsonl`)); } catch { /* best-effort */ }
console.log(`Done. ${uploaded} reexam(s) processed — ${named} requester name(s) recovered from TRNA; ${bad} rejected.`);
console.log('(Gap-fill only: rows that already had a name are left untouched by the guarded update.)');
try { await sql.end(); } catch { /* already closed */ }
