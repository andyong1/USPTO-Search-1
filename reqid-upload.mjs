// Upload the requester-identity pass (produced per reqid-verify.md) into
// reexam_requester. Companion to reqid-fetch.mjs.

import { readFile, rename } from 'node:fs/promises';
import { sql } from '@vercel/postgres';
import { setReexamRequester } from './lib/db.js';

if (!process.env.POSTGRES_URL) {
  console.error('POSTGRES_URL is not set. Load it from grounds-secrets.env first.');
  process.exit(1);
}

const DIR = 'snq-cumulative/reqid-work';
const IN = `${DIR}/reqid-out.jsonl`;
const clean = (v) => v == null ? '' : String(v).replace(/\s+/g, ' ').trim();

let manifestApps;
try { manifestApps = new Set(JSON.parse(await readFile(`${DIR}/manifest.json`, 'utf-8')).map((m) => m.application_number)); }
catch { console.error('No manifest.json — run reqid-fetch.mjs first.'); process.exit(1); }

let raw;
try { raw = await readFile(IN, 'utf-8'); }
catch { console.error(`No ${IN} found — run reqid-fetch.mjs and verify first.`); process.exit(1); }

let uploaded = 0, named = 0, bad = 0;
for (const line of raw.split(/\r?\n/)) {
  if (!line.trim()) continue;
  let o;
  try { o = JSON.parse(line); } catch { bad++; continue; }
  const app = clean(o.application_number);
  if (!app || !manifestApps.has(app)) { bad++; console.error('  not in manifest:', app || line.slice(0, 60)); continue; }
  const name = clean(o.requester_name).slice(0, 120);
  await setReexamRequester(app, {
    requester_name: name || null,
    confidence: clean(o.confidence).toLowerCase() || null,
    note: clean(o.note).slice(0, 300) || null,
  });
  uploaded++;
  if (name) named++;
}

try { await rename(IN, IN.replace(/\.jsonl$/, `.${Date.now()}.done.jsonl`)); } catch { /* best-effort */ }
console.log(`Done. ${uploaded} reexam(s) uploaded — ${named} with a named requester; ${bad} rejected.`);
try { await sql.end(); } catch { /* already closed */ }
