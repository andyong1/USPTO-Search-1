// Stage reexam OPPOSITION documents so we can read WHAT EACH ONE OPPOSES rather
// than inferring it from filing order. Filing order guessed wrong: in 90/015,704
// a paper opposing a patent owner filing the Office never entered into the
// wrapper was attached to an unrelated requester petition, so the page asserted
// an opposition that never answered that petition.
//
// An opposition names its target in the caption ("Opposition to Patent Owner's
// Petition filed March 30, 2026"), so only the FRONT pages are needed; the rest
// is argument. DIRECT from USPTO (zero Vercel transfer).
// Companion: petopp-ocr.py → petopp-verify.md → petopp-upload.mjs.
//
//     set -a && . ./grounds-secrets.env && set +a && node petopp-fetch.mjs [--limit N] [--dir NAME]

import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { sql } from '@vercel/postgres';
import pdfParse from 'pdf-parse/lib/pdf-parse.js';
import { fetchDocumentBytes } from './lib/uspto.js';
import { getOppositionsNeedingSubject, countOppositionsNeedingSubject } from './lib/db.js';

if (!process.env.POSTGRES_URL || !process.env.USPTO_API_KEY) {
  console.error('POSTGRES_URL and USPTO_API_KEY required — source grounds-secrets.env.');
  process.exit(1);
}
const args = process.argv.slice(2);
const num = (flag, def) => { const i = args.indexOf(flag); return i >= 0 ? Number(args[i + 1]) : def; };
const str = (flag, def) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : def; };
const LIMIT = num('--limit', 100000);
const DIR = `snq-cumulative/${str('--dir', 'petopp-prod')}`;
const DL_MS = num('--timeout', 30000);

// Neon's serverless driver intermittently drops the TLS connection (ECONNRESET)
// on an otherwise fine query; a long unattended run must not die on that.
async function retry(label, fn, attempts = 4) {
  for (let i = 1; ; i++) {
    try { return await fn(); }
    catch (e) {
      const transient = /ECONNRESET|fetch failed|ETIMEDOUT|socket hang up/i.test(String(e.message || e));
      if (!transient || i >= attempts) throw e;
      const wait = 1500 * i;
      console.log(`  ${label}: transient DB error (attempt ${i}/${attempts}), retrying in ${wait}ms…`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

await mkdir(`${DIR}/pdf`, { recursive: true });
const rows = await retry('queue', () => getOppositionsNeedingSubject(LIMIT));
console.log(`${rows.length} opposition(s) need reading. Downloading (DIRECT)…`);

let manifest = [];
try { manifest = JSON.parse(await readFile(`${DIR}/manifest.json`, 'utf-8')); } catch { /* first run */ }
const have = new Set(manifest.map((m) => m.doc_id));

let ok = 0, fail = 0, pagesTotal = 0;
for (const r of rows) {
  if (have.has(r.doc_id)) { ok++; continue; }
  try {
    const { buffer } = await fetchDocumentBytes(r.application_number, r.doc_id, 'PDF', DL_MS);
    let pages = 0;
    try { pages = (await pdfParse(buffer)).numpages || 0; } catch { /* image-only */ }
    await writeFile(`${DIR}/pdf/${r.application_number}__${r.doc_id}.pdf`, buffer);
    manifest.push({
      application_number: r.application_number, doc_id: r.doc_id,
      opposition_date: r.official_date, doc_code: r.doc_code,
      // Context for a human reading the manifest only. The classifier is NOT
      // given this — telling it which petition we think is nearby would invite
      // it to confirm the very guess this pass exists to check.
      nearest_petition_date: r.nearest_petition_date || null,
      file: `${r.application_number}__${r.doc_id}.txt`, pages,
    });
    pagesTotal += pages; ok++;
    if (ok % 25 === 0) console.log(`  …${ok}/${rows.length} staged (${pagesTotal} pages)`);
  } catch (e) { fail++; console.log(`  ${r.application_number}: ${e.message.slice(0, 90)}`); }
}
await writeFile(`${DIR}/manifest.json`, JSON.stringify(manifest, null, 1), 'utf-8');
console.log(`\nStaged ${ok} (${fail} failed). Manifest ${manifest.length} entries, ${pagesTotal} new pages.`);
const left = await retry('count', () => countOppositionsNeedingSubject()).catch(() => '?');
console.log(`${left} opposition(s) still awaiting extraction.`);
console.log('Next: cat petopp-ocr.py | python -');
try { await sql.end(); } catch { /* */ }
