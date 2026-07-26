// Upload the AI NIRC prior-art comparison (produced by the nightly Claude
// session per nirc-verify.md) into reexam_nirc_art. Companion to nirc-fetch.mjs.
//
// Input: snq-cumulative/nirc-work/nirc-out.jsonl — one JSON object per proceeding
// (see nirc-verify.md for the shape). Overlap counts are computed in setNircArt,
// not taken from the model.
//
// Requires POSTGRES_URL in the environment. Run from the uspto-search folder:
//     node nirc-upload.mjs

import { readFile, rename } from 'node:fs/promises';
import { sql } from '@vercel/postgres';
import { setNircArt } from './lib/db.js';

if (!process.env.POSTGRES_URL) {
  console.error('POSTGRES_URL is not set. Load it from grounds-secrets.env first.');
  process.exit(1);
}

const DIR = 'snq-cumulative/nirc-work';
const IN = `${DIR}/nirc-out.jsonl`;
const ROLES = new Set(['invalidating', 'distinguished', 'mentioned']);
const BASES = new Set(['reasons-stated', 'as-amended', 'not-stated', 'no-nirc-art']);
const clean = (v) => v == null ? '' : String(v).replace(/\s+/g, ' ').trim();

// Keep only well-formed {label, key[, role]} refs; drop junk so a stray value
// can't inflate a count.
function refs(arr, withRole) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const r of arr) {
    if (!r || typeof r !== 'object') continue;
    const key = clean(r.key).toLowerCase();
    const label = clean(r.label) || clean(r.key);
    if (!key || !label) continue;
    const o = { label: label.slice(0, 120), key: key.slice(0, 40) };
    if (withRole) o.role = ROLES.has(r.role) ? r.role : 'mentioned';
    out.push(o);
  }
  return out;
}

let manifest;
try { manifest = JSON.parse(await readFile(`${DIR}/manifest.json`, 'utf-8')); }
catch { console.error('No manifest.json — run nirc-fetch.mjs first.'); process.exit(1); }
const known = new Set(manifest.map((m) => m.application_number));

let raw;
try { raw = await readFile(IN, 'utf-8'); }
catch { console.error(`No ${IN} found — run nirc-fetch.mjs and verify first.`); process.exit(1); }

let uploaded = 0, withOverlap = 0, notStated = 0, bad = 0;
for (const line of raw.split(/\r?\n/)) {
  if (!line.trim()) continue;
  let o;
  try { o = JSON.parse(line); } catch { bad++; continue; }
  const app = clean(o.application_number);
  if (!app || !known.has(app)) { bad++; console.error('  not in manifest:', app || line.slice(0, 60)); continue; }

  const reqRefs = refs(o.req_refs, false);
  const nircRefs = refs(o.nirc_refs, true);
  const reqKeys = new Set(reqRefs.map((r) => r.key));
  const nircByKey = new Map(nircRefs.map((r) => [r.key, r]));
  // Recompute matches from the two lists so a match must genuinely appear in
  // both — the model's own matches[] is only a hint.
  const matches = [];
  for (const k of reqKeys) if (nircByKey.has(k)) { const nr = nircByKey.get(k); matches.push({ label: nr.label, key: k, role: nr.role }); }
  const basis = BASES.has(clean(o.basis)) ? clean(o.basis) : (nircRefs.length ? 'reasons-stated' : 'not-stated');

  await setNircArt(app, {
    req_refs: reqRefs, nirc_refs: nircRefs, matches, basis,
    confidence: clean(o.confidence).toLowerCase() || null,
    note: clean(o.note).slice(0, 300) || null,
  });
  uploaded++;
  if (matches.length) withOverlap++;
  if (basis === 'not-stated' || basis === 'no-nirc-art') notStated++;
}

try { await rename(IN, IN.replace(/\.jsonl$/, `.${Date.now()}.done.jsonl`)); } catch { /* best-effort */ }
console.log(`Done. ${uploaded} proceeding(s) uploaded — ${withOverlap} with request-art operative in the NIRC, ${notStated} with no art-based reasons; ${bad} rejected.`);
try { await sql.end(); } catch { /* already closed */ }
