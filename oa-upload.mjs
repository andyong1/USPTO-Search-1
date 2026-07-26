// Upload the final-Office-action art pass (produced per oa-verify.md) into
// reexam_nirc_art. Companion to oa-fetch.mjs. Recomputes matches (a match must
// appear in both the manifest req_refs and the model's oa_refs) so a stray
// value can't inflate a count.

import { readFile, rename } from 'node:fs/promises';
import { sql } from '@vercel/postgres';
import { setNircFinalOa } from './lib/db.js';

if (!process.env.POSTGRES_URL) {
  console.error('POSTGRES_URL is not set. Load it from grounds-secrets.env first.');
  process.exit(1);
}

const DIR = 'snq-cumulative/oa-work';
const IN = `${DIR}/oa-out.jsonl`;
const ROLES = new Set(['invalidating', 'distinguished', 'mentioned']);
const clean = (v) => v == null ? '' : String(v).replace(/\s+/g, ' ').trim();
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
catch { console.error('No manifest.json — run oa-fetch.mjs first.'); process.exit(1); }
const reqByApp = new Map(manifest.map((m) => [m.application_number, new Set((m.req_refs || []).map((r) => String(r.key).toLowerCase()))]));

let raw;
try { raw = await readFile(IN, 'utf-8'); }
catch { console.error(`No ${IN} found — run oa-fetch.mjs and verify first.`); process.exit(1); }

let uploaded = 0, withMatch = 0, inval = 0, bad = 0;
for (const line of raw.split(/\r?\n/)) {
  if (!line.trim()) continue;
  let o;
  try { o = JSON.parse(line); } catch { bad++; continue; }
  const app = clean(o.application_number);
  if (!app || !reqByApp.has(app)) { bad++; console.error('  not in manifest:', app || line.slice(0, 60)); continue; }
  const oaRefs = refs(o.oa_refs, true);
  const reqKeys = reqByApp.get(app);
  const oaByKey = new Map(oaRefs.map((r) => [r.key, r]));
  // Recompute matches: request refs that appear in the action's operative art.
  const matches = [];
  for (const k of reqKeys) if (oaByKey.has(k)) { const r = oaByKey.get(k); matches.push({ label: r.label, key: k, role: r.role }); }
  await setNircFinalOa(app, { oa_refs: oaRefs, matches, confidence: clean(o.confidence).toLowerCase() || null, note: clean(o.note).slice(0, 300) || null });
  uploaded++;
  if (matches.length) withMatch++;
  if (matches.some((m) => m.role === 'invalidating')) inval++;
}

try { await rename(IN, IN.replace(/\.jsonl$/, `.${Date.now()}.done.jsonl`)); } catch { /* best-effort */ }
console.log(`Done. ${uploaded} row(s) filled from the final Office action — ${withMatch} with request-art operative (${inval} invalidating); ${bad} rejected.`);
try { await sql.end(); } catch { /* already closed */ }
