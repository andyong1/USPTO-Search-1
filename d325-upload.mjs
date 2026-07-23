// Upload AI §325(d) summaries produced by the nightly Claude session (see
// d325-summarize.md) into reexam_doc_text. Companion to d325-fetch.mjs.
//
// Input: snq-cumulative/d325-work/d325-out.jsonl — one JSON object per line:
//   { "doc_id": "...", "addressed": "Yes" | "No" | "No explicit §325(d) section located" | "Text quality too low",
//     "summary": "2-4 sentence summary" | null }
//
// Requires POSTGRES_URL in the environment. Run from the uspto-search folder:
//     node d325-upload.mjs

import { readFile, rename } from 'node:fs/promises';
import { sql } from '@vercel/postgres';

if (!process.env.POSTGRES_URL) {
  console.error('POSTGRES_URL is not set. Load it from grounds-secrets.env first.');
  process.exit(1);
}

const IN = 'snq-cumulative/d325-work/d325-out.jsonl';
const ADDRESSED = new Set(['Yes', 'No', 'No explicit §325(d) section located', 'Text quality too low']);
// Postgres text rejects NUL bytes; strip them (constructed via charCode so the
// source file itself never contains the raw byte).
const NUL = new RegExp(String.fromCharCode(0), 'g');

let raw;
try { raw = await readFile(IN, 'utf-8'); }
catch { console.error(`No ${IN} found — run d325-fetch.mjs and summarize first.`); process.exit(1); }

let uploaded = 0, bad = 0;
for (const line of raw.split(/\r?\n/)) {
  if (!line.trim()) continue;
  let o;
  try { o = JSON.parse(line); } catch { bad++; continue; }
  const summary = o.summary ? String(o.summary).replace(NUL, '').trim().slice(0, 1500) : null;
  if (!o.doc_id || !ADDRESSED.has(o.addressed) || (o.addressed === 'Yes' && !summary)) { bad++; console.error('  invalid row:', line.slice(0, 120)); continue; }
  const { rowCount } = await sql`
    UPDATE reexam_doc_text
    SET d325_addressed = ${o.addressed}, d325_summary = ${summary}, d325_sum_v = 1
    WHERE doc_id = ${String(o.doc_id)}`;
  if (rowCount > 0) uploaded++; else { bad++; console.error('  unknown doc_id:', o.doc_id); }
}

// Archive the batch so a re-run can't double-process it.
try { await rename(IN, IN.replace(/\.jsonl$/, `.${Date.now()}.done.jsonl`)); } catch { /* best-effort */ }
console.log(`Done. ${uploaded} summaries uploaded, ${bad} rejected.`);
// Close the pool, then exit naturally — process.exit() while the pool's libuv
// async handles are closing trips an assertion on Windows (exit code 127).
try { await sql.end(); } catch { /* already closed */ }
