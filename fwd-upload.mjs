// Upload AI-verified FWD outcomes (produced by the nightly Claude session per
// fwd-verify.md) into ptab_fwd (ai_* columns). Companion to fwd-fetch.mjs.
//
// Input: snq-cumulative/fwd-work/fwd-out.jsonl — one JSON object per line:
//   {"trial_number":"...","outcome":"partial","unpatentable":"","upheld":"","confidence":"high","note":""}
//
// Requires POSTGRES_URL in the environment. Run from the uspto-search folder:
//     node fwd-upload.mjs

import { readFile, rename } from 'node:fs/promises';
import { sql } from '@vercel/postgres';
import { setFwdAiOutcome } from './lib/db.js';

if (!process.env.POSTGRES_URL) {
  console.error('POSTGRES_URL is not set. Load it from grounds-secrets.env first.');
  process.exit(1);
}

const IN = 'snq-cumulative/fwd-work/fwd-out.jsonl';
const OUTCOMES = new Set(['petitioner_all', 'po_none', 'partial', 'adverse_judgment', 'settled', 'needs_review']);
const CONF = new Set(['high', 'medium', 'low']);
const NUL = new RegExp(String.fromCharCode(0), 'g');
const clean = (v) => v == null ? '' : String(v).replace(NUL, '').replace(/\s+/g, ' ').trim();

let raw;
try { raw = await readFile(IN, 'utf-8'); }
catch { console.error(`No ${IN} found — run fwd-fetch.mjs and verify first.`); process.exit(1); }

let uploaded = 0, bad = 0;
for (const line of raw.split(/\r?\n/)) {
  if (!line.trim()) continue;
  let o;
  try { o = JSON.parse(line); } catch { bad++; continue; }
  const trial = clean(o.trial_number);
  const outcome = clean(o.outcome).toLowerCase();
  const confidence = clean(o.confidence).toLowerCase();
  if (!trial || !OUTCOMES.has(outcome) || !CONF.has(confidence)) { bad++; console.error('  invalid row:', line.slice(0, 120)); continue; }
  await setFwdAiOutcome(trial, {
    outcome, unpatentable: clean(o.unpatentable), upheld: clean(o.upheld),
    confidence, note: clean(o.note).slice(0, 200),
  });
  uploaded++;
}

try { await rename(IN, IN.replace(/\.jsonl$/, `.${Date.now()}.done.jsonl`)); } catch { /* best-effort */ }
console.log(`Done. ${uploaded} FWD outcomes uploaded, ${bad} rejected.`);
try { await sql.end(); } catch { /* already closed */ }
