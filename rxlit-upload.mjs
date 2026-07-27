// Upload the related-litigation pass (produced per rxlit-verify.md) into
// reexam_litigation. Companion to rxlit-fetch.mjs. Validates each case: a
// district-court civil action with a caption; case_no normalized loosely;
// court kept only as a recognizable district shorthand; status constrained.

import { readFile, rename } from 'node:fs/promises';
import { sql } from '@vercel/postgres';
import { setReexamLitigation } from './lib/db.js';

if (!process.env.POSTGRES_URL) {
  console.error('POSTGRES_URL is not set. Load it from grounds-secrets.env first.');
  process.exit(1);
}

const DIR = 'snq-cumulative/rxlit-work';
const IN = `${DIR}/rxlit-out.jsonl`;
const STATUS = new Set(['open', 'closed', 'unknown']);
const clean = (v) => v == null ? '' : String(v).replace(/\s+/g, ' ').trim();

// Keep court only when it reads like a district shorthand (D. Del., E.D. Tex.,
// N.D. Cal., …) or "District of X"; drop anything else so we never assert a bad court.
function court(v) {
  const s = clean(v);
  if (!s) return '';
  if (/^[NSEWMC]?\.?\s?D\.?\s?[A-Z][A-Za-z.]*\.?$/.test(s)) return s;
  if (/district of/i.test(s)) return s;
  if (/(Fed\.?\s?Cir|ITC|PTAB)/i.test(s)) return ''; // not a district court
  return s.length <= 12 ? s : ''; // tolerate short forms, drop prose
}
function cases(arr) {
  if (!Array.isArray(arr)) return [];
  const out = [], seen = new Set();
  for (const c of arr) {
    if (!c || typeof c !== 'object') continue;
    const caption = clean(c.caption).slice(0, 160);
    const case_no = clean(c.case_no).slice(0, 40);
    if (!caption && !case_no) continue;
    const key = (case_no || caption).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const status = STATUS.has(clean(c.status).toLowerCase()) ? clean(c.status).toLowerCase() : 'unknown';
    out.push({ caption, case_no, court: court(c.court), status });
  }
  return out;
}

let manifestApps;
try { manifestApps = new Set(JSON.parse(await readFile(`${DIR}/manifest.json`, 'utf-8')).map((m) => m.application_number)); }
catch { console.error('No manifest.json — run rxlit-fetch.mjs first.'); process.exit(1); }

let raw;
try { raw = await readFile(IN, 'utf-8'); }
catch { console.error(`No ${IN} found — run rxlit-fetch.mjs and verify first.`); process.exit(1); }

let uploaded = 0, withCases = 0, none = 0, bad = 0;
for (const line of raw.split(/\r?\n/)) {
  if (!line.trim()) continue;
  let o;
  try { o = JSON.parse(line); } catch { bad++; continue; }
  const app = clean(o.application_number);
  if (!app || !manifestApps.has(app)) { bad++; console.error('  not in manifest:', app || line.slice(0, 60)); continue; }
  const list = cases(o.cases);
  await setReexamLitigation(app, {
    cases: list,
    none_found: !!o.none_found && list.length === 0,
    confidence: clean(o.confidence).toLowerCase() || null,
    note: clean(o.note).slice(0, 300) || null,
  });
  uploaded++;
  if (list.length) withCases++;
  else if (o.none_found) none++;
}

try { await rename(IN, IN.replace(/\.jsonl$/, `.${Date.now()}.done.jsonl`)); } catch { /* best-effort */ }
console.log(`Done. ${uploaded} reexam(s) uploaded — ${withCases} with litigation, ${none} none-found; ${bad} rejected.`);
try { await sql.end(); } catch { /* already closed */ }
