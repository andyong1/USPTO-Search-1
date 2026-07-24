// Upload the AI residual litigation pass (produced by the nightly Claude session
// per lit-verify.md) into ptab_petition_refs (ai_lit_* columns). Companion to
// lit-fetch.mjs.
//
// Input: snq-cumulative/lit-work/lit-out.jsonl — one JSON object per line:
//   {"trial_number":"...","petitioner":["E.D. Tex."],"other":["D. Del."],"note":""}
//
// Requires POSTGRES_URL in the environment. Run from the uspto-search folder:
//     node lit-upload.mjs

import { readFile, rename } from 'node:fs/promises';
import { sql } from '@vercel/postgres';
import { setLitAi } from './lib/db.js';

if (!process.env.POSTGRES_URL) {
  console.error('POSTGRES_URL is not set. Load it from grounds-secrets.env first.');
  process.exit(1);
}

const IN = 'snq-cumulative/lit-work/lit-out.jsonl';
const NUL = new RegExp(String.fromCharCode(0), 'g');
const clean = (v) => v == null ? '' : String(v).replace(NUL, '').replace(/\s+/g, ' ').trim();
// A district-court shorthand: optional direction + D. + state abbrev, or D.D.C./
// S.D.N.Y.-style. Drops anything that isn't court-shaped (guards against stray
// text or an ITC/case-number slipping into the arrays).
const COURT_RE = /^([NSEWMC]\.)?D\.?\s?[A-Z][A-Za-z.]{0,12}\.?$|^[NSEWMC]\.D\.[A-Z.]{2,6}$|^D\.D\.C\.$/;
const courts = (arr) => Array.isArray(arr)
  ? [...new Set(arr.map(clean).filter((c) => c && COURT_RE.test(c)))]
  : [];

let raw;
try { raw = await readFile(IN, 'utf-8'); }
catch { console.error(`No ${IN} found — run lit-fetch.mjs and verify first.`); process.exit(1); }

let uploaded = 0, withCourts = 0, bad = 0, dropped = 0;
for (const line of raw.split(/\r?\n/)) {
  if (!line.trim()) continue;
  let o;
  try { o = JSON.parse(line); } catch { bad++; continue; }
  const trial = clean(o.trial_number);
  if (!trial) { bad++; console.error('  no trial_number:', line.slice(0, 100)); continue; }
  const pet = courts(o.petitioner), oth = courts(o.other);
  const rawCount = (Array.isArray(o.petitioner) ? o.petitioner.length : 0) + (Array.isArray(o.other) ? o.other.length : 0);
  if (rawCount > pet.length + oth.length) dropped++;
  await setLitAi(trial, { petitioner: pet, other: oth, note: clean(o.note).slice(0, 200) });
  uploaded++;
  if (pet.length || oth.length) withCourts++;
}

try { await rename(IN, IN.replace(/\.jsonl$/, `.${Date.now()}.done.jsonl`)); } catch { /* best-effort */ }
console.log(`Done. ${uploaded} rows uploaded (${withCourts} with courts recovered), ${bad} rejected, ${dropped} row(s) had non-court values dropped.`);
try { await sql.end(); } catch { /* already closed */ }
