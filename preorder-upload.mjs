// Upload the AI pre-order requester-attribution pass (produced by the nightly
// Claude session per preorder-verify.md) into reexam_preorder (ai_* columns).
// Companion to preorder-fetch.mjs.
//
// Input: snq-cumulative/preorder-work/preorder-out.jsonl — one JSON object per
// proceeding:
//   {"application_number":"90016339","pet_doc_id":"...","dec_doc_id":"...",
//    "dec_outcome":"granted","confidence":"high","note":""}
// Dates are derived from the manifest's candidate metadata (the AI only picks
// doc ids), so a hallucinated id or date cannot reach the table.
//
// Requires POSTGRES_URL in the environment. Run from the uspto-search folder:
//     node preorder-upload.mjs

import { readFile, rename } from 'node:fs/promises';
import { sql } from '@vercel/postgres';
import { setPreorderAi } from './lib/db.js';

if (!process.env.POSTGRES_URL) {
  console.error('POSTGRES_URL is not set. Load it from grounds-secrets.env first.');
  process.exit(1);
}

const DIR = 'snq-cumulative/preorder-work';
const IN = `${DIR}/preorder-out.jsonl`;
const OUTCOMES = new Set(['granted', 'dismissed', 'denied']);
const clean = (v) => v == null ? '' : String(v).replace(/\s+/g, ' ').trim();

let manifest;
try { manifest = JSON.parse(await readFile(`${DIR}/manifest.json`, 'utf-8')); }
catch { console.error('No manifest.json — run preorder-fetch.mjs first.'); process.exit(1); }
const byApp = new Map(manifest.map((m) => [m.application_number, m]));

let raw;
try { raw = await readFile(IN, 'utf-8'); }
catch { console.error(`No ${IN} found — run preorder-fetch.mjs and verify first.`); process.exit(1); }

let uploaded = 0, blanked = 0, changedPet = 0, changedDec = 0, bad = 0;
for (const line of raw.split(/\r?\n/)) {
  if (!line.trim()) continue;
  let o;
  try { o = JSON.parse(line); } catch { bad++; continue; }
  const app = clean(o.application_number);
  const m = byApp.get(app);
  if (!m) { bad++; console.error('  not in manifest:', app || line.slice(0, 60)); continue; }

  const cand = (id, kind) => m.candidates.find((c) => c.doc_id === id && c.kind === kind);
  const pet = o.pet_doc_id ? cand(clean(o.pet_doc_id), 'petition') : null;
  if (o.pet_doc_id && !pet) { bad++; console.error(`  ${app}: pet_doc_id not a petition candidate`); continue; }
  const dec = o.dec_doc_id ? cand(clean(o.dec_doc_id), 'decision') : null;
  if (o.dec_doc_id && !dec) { bad++; console.error(`  ${app}: dec_doc_id not a decision candidate`); continue; }
  const outcome = clean(o.dec_outcome).toLowerCase();
  if (dec && !OUTCOMES.has(outcome)) { bad++; console.error(`  ${app}: bad dec_outcome "${outcome}"`); continue; }

  await setPreorderAi(app, {
    petDocId: pet ? pet.doc_id : null, petDate: pet ? pet.date : null,
    decDocId: dec ? dec.doc_id : null, decDate: dec ? dec.date : null,
    decOutcome: dec ? outcome : null,
    confidence: clean(o.confidence).toLowerCase() || null,
    note: clean(o.note).slice(0, 300) || null,
  });
  uploaded++;
  if (!pet && !dec) blanked++;
  if ((pet ? pet.doc_id : null) !== (m.flagged.pet_doc_id || null)) changedPet++;
  if ((dec ? dec.doc_id : null) !== (m.flagged.dec_doc_id || null)) changedDec++;
}

try { await rename(IN, IN.replace(/\.jsonl$/, `.${Date.now()}.done.jsonl`)); } catch { /* best-effort */ }
console.log(`Done. ${uploaded} proceeding(s) uploaded — petition changed on ${changedPet}, decision changed on ${changedDec}, fully blanked on ${blanked}; ${bad} rejected.`);
try { await sql.end(); } catch { /* already closed */ }
