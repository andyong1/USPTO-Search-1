// Upload the AI post-order petition attribution pass (produced by the nightly
// Claude session per postpet-verify.md) into reexam_post_petitions (ai_*
// columns). Companion to postpet-fetch.mjs.
//
// Input: snq-cumulative/postpet-work/postpet-out.jsonl — one JSON object per
// proceeding:
//   {"application_number":"90015000","pet_doc_id":"...","pet_325d":true,
//    "opp_doc_id":"...","dec_doc_id":"...","dec_outcome":"dismissed",
//    "dec_325d":true,"confidence":"high","note":""}
// Dates are derived from the manifest's candidate metadata (the AI only picks
// doc ids), so a hallucinated id or date cannot reach the table.
//
// Requires POSTGRES_URL in the environment. Run from the uspto-search folder:
//     node postpet-upload.mjs

import { readFile, rename } from 'node:fs/promises';
import { sql } from '@vercel/postgres';
import { setPostPetAi } from './lib/db.js';

if (!process.env.POSTGRES_URL) {
  console.error('POSTGRES_URL is not set. Load it from grounds-secrets.env first.');
  process.exit(1);
}

const DIR = 'snq-cumulative/postpet-work';
const IN = `${DIR}/postpet-out.jsonl`;
const OUTCOMES = new Set(['granted', 'dismissed', 'denied']);
const clean = (v) => v == null ? '' : String(v).replace(/\s+/g, ' ').trim();
const bool = (v) => v === true ? true : v === false ? false : null;

let manifest;
try { manifest = JSON.parse(await readFile(`${DIR}/manifest.json`, 'utf-8')); }
catch { console.error('No manifest.json — run postpet-fetch.mjs first.'); process.exit(1); }
const byApp = new Map(manifest.map((m) => [m.application_number, m]));

let raw;
try { raw = await readFile(IN, 'utf-8'); }
catch { console.error(`No ${IN} found — run postpet-fetch.mjs and verify first.`); process.exit(1); }

let uploaded = 0, blanked = 0, changed = 0, bad = 0;
for (const line of raw.split(/\r?\n/)) {
  if (!line.trim()) continue;
  let o;
  try { o = JSON.parse(line); } catch { bad++; continue; }
  const app = clean(o.application_number);
  const m = byApp.get(app);
  if (!m) { bad++; console.error('  not in manifest:', app || line.slice(0, 60)); continue; }

  const cand = (id, kinds) => m.candidates.find((c) => c.doc_id === id && kinds.includes(c.kind));
  const pet = o.pet_doc_id ? cand(clean(o.pet_doc_id), ['petition-paper']) : null;
  if (o.pet_doc_id && !pet) { bad++; console.error(`  ${app}: pet_doc_id not a petition-paper candidate`); continue; }
  const opp = o.opp_doc_id ? cand(clean(o.opp_doc_id), ['opposition', 'petition-paper']) : null;
  if (o.opp_doc_id && !opp) { bad++; console.error(`  ${app}: opp_doc_id not an opposition/petition-paper candidate`); continue; }
  const dec = o.dec_doc_id ? cand(clean(o.dec_doc_id), ['decision']) : null;
  if (o.dec_doc_id && !dec) { bad++; console.error(`  ${app}: dec_doc_id not a decision candidate`); continue; }
  const outcome = clean(o.dec_outcome).toLowerCase();
  if (dec && !OUTCOMES.has(outcome)) { bad++; console.error(`  ${app}: bad dec_outcome "${outcome}"`); continue; }

  await setPostPetAi(app, {
    petDocId: pet ? pet.doc_id : null, petDate: pet ? pet.date : null, pet325d: pet ? bool(o.pet_325d) : null,
    oppDocId: opp ? opp.doc_id : null, oppDate: opp ? opp.date : null,
    decDocId: dec ? dec.doc_id : null, decDate: dec ? dec.date : null,
    decOutcome: dec ? outcome : null, dec325d: dec ? bool(o.dec_325d) : null,
    confidence: clean(o.confidence).toLowerCase() || null,
    note: clean(o.note).slice(0, 300) || null,
  });
  uploaded++;
  if (!pet) blanked++;
  if ((pet ? pet.doc_id : null) !== (m.flagged.pet_doc_id || null)
      || (dec ? dec.doc_id : null) !== (m.flagged.dec_doc_id || null)
      || (opp ? opp.doc_id : null) !== (m.flagged.opp_doc_id || null)) changed++;
}

try { await rename(IN, IN.replace(/\.jsonl$/, `.${Date.now()}.done.jsonl`)); } catch { /* best-effort */ }
console.log(`Done. ${uploaded} proceeding(s) uploaded — attribution changed on ${changed}, no-PO-325(d)-petition on ${blanked}; ${bad} rejected.`);
try { await sql.end(); } catch { /* already closed */ }
