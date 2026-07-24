// Upload AI-verified certificate claim dispositions (produced by the nightly
// Claude session per cert-verify.md) into reexam_conclusions. Companion to
// cert-fetch.mjs.
//
// Input: snq-cumulative/cert-work/cert-out.jsonl — one JSON object per line:
//   {"application_number":"...","confirmed":"","cancelled":"","amended":"","new":"","confidence":"high","note":""}
//
// Requires POSTGRES_URL in the environment. Run from the uspto-search folder:
//     node cert-upload.mjs

import { readFile, rename } from 'node:fs/promises';
import { sql } from '@vercel/postgres';
import { setCertAiOutcome } from './lib/db.js';

if (!process.env.POSTGRES_URL) {
  console.error('POSTGRES_URL is not set. Load it from grounds-secrets.env first.');
  process.exit(1);
}

const IN = 'snq-cumulative/cert-work/cert-out.jsonl';
const CONF = new Set(['high', 'medium', 'low']);
// Postgres text rejects NUL bytes; strip them (built via charCode so this source
// file never contains the raw byte).
const NUL = new RegExp(String.fromCharCode(0), 'g');
const clean = (v) => v == null ? '' : String(v).replace(NUL, '').replace(/\s+/g, ' ').trim();

let raw;
try { raw = await readFile(IN, 'utf-8'); }
catch { console.error(`No ${IN} found — run cert-fetch.mjs and verify first.`); process.exit(1); }

let uploaded = 0, bad = 0;
for (const line of raw.split(/\r?\n/)) {
  if (!line.trim()) continue;
  let o;
  try { o = JSON.parse(line); } catch { bad++; continue; }
  const appNum = clean(o.application_number);
  const confirmed = clean(o.confirmed), cancelled = clean(o.cancelled), amended = clean(o.amended), added = clean(o.new);
  const confidence = clean(o.confidence).toLowerCase();
  if (!appNum || !CONF.has(confidence)) { bad++; console.error('  invalid row:', line.slice(0, 120)); continue; }
  // A certificate always disposes of claims; all-empty is only acceptable when
  // flagged low-confidence (e.g. unreadable OCR / wrong-proceeding exhibit).
  if (!confirmed && !cancelled && !amended && !added && confidence !== 'low') { bad++; console.error('  empty disposition w/o low confidence:', appNum); continue; }
  // Compose the summary in the same order as the regex parser's outcome_summary.
  const parts = [];
  if (confirmed) parts.push(`Confirmed ${confirmed}`);
  if (amended) parts.push(`Amended ${amended}`);
  if (added) parts.push(`New ${added}`);
  if (cancelled) parts.push(`Cancelled ${cancelled}`);
  const summary = parts.join(' · ');
  await setCertAiOutcome(appNum, { confirmed, cancelled, amended, new: added, summary, confidence, note: clean(o.note).slice(0, 200) });
  uploaded++;
}

try { await rename(IN, IN.replace(/\.jsonl$/, `.${Date.now()}.done.jsonl`)); } catch { /* best-effort */ }
console.log(`Done. ${uploaded} certificate outcomes uploaded, ${bad} rejected.`);
try { await sql.end(); } catch { /* already closed */ }
