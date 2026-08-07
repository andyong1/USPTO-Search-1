// Stage reexam petition DECISIONS for the subject-matter pass: OCR + AI extract
// which relief the petition requested and how it was resolved on the MERITS.
// Decisions are the cheap source — they're short (avg ~6pp) and conventionally
// recite both the relief sought and the disposition (validated 29/29 on a
// sample), so one short document yields subject matter for a whole petition
// thread. DIRECT from USPTO with a local key (zero Vercel transfer).
// Companion: petsubj-ocr.py → petsubj-verify.md → petsubj-upload.mjs.
//
//     set -a && . ./grounds-secrets.env && set +a && node petsubj-fetch.mjs [--limit N] [--dir NAME]

import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { sql } from '@vercel/postgres';
import pdfParse from 'pdf-parse/lib/pdf-parse.js';
import { fetchDocumentBytes } from './lib/uspto.js';
import { getDecisionsNeedingSubject, countDecisionsNeedingSubject } from './lib/db.js';

if (!process.env.POSTGRES_URL || !process.env.USPTO_API_KEY) {
  console.error('POSTGRES_URL and USPTO_API_KEY required — source grounds-secrets.env.');
  process.exit(1);
}
const args = process.argv.slice(2);
const num = (flag, def) => { const i = args.indexOf(flag); return i >= 0 ? Number(args[i + 1]) : def; };
const str = (flag, def) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : def; };
const LIMIT = num('--limit', 100000);
const DIR = `snq-cumulative/${str('--dir', 'petsubj-prod')}`;

await mkdir(`${DIR}/pdf`, { recursive: true });
const rows = await getDecisionsNeedingSubject(LIMIT);
console.log(`${rows.length} decision(s) need subject-matter classification. Downloading (DIRECT)…`);

// Append to a shared manifest so repeated runs accumulate.
let manifest = [];
try { manifest = JSON.parse(await readFile(`${DIR}/manifest.json`, 'utf-8')); } catch { /* first run */ }
const have = new Set(manifest.map((m) => m.doc_id));

let ok = 0, fail = 0, pagesTotal = 0;
for (const r of rows) {
  if (have.has(r.doc_id)) { ok++; continue; }
  try {
    const { buffer } = await fetchDocumentBytes(r.application_number, r.doc_id, 'PDF', 30000);
    let pages = 0;
    try { pages = (await pdfParse(buffer)).numpages || 0; } catch { /* image-only: page count unknown */ }
    await writeFile(`${DIR}/pdf/${r.application_number}__${r.doc_id}.pdf`, buffer);
    manifest.push({
      application_number: r.application_number, doc_id: r.doc_id,
      decision_date: r.official_date, doc_code: r.doc_code,
      // The doc-code outcome is deliberately NOT given to the AI pass — it stays
      // an independent cross-check of what the decision text actually says.
      code_outcome: r.outcome,
      file: `${r.application_number}__${r.doc_id}.txt`, pages,
    });
    pagesTotal += pages; ok++;
    if (ok % 25 === 0) console.log(`  …${ok}/${rows.length} staged (${pagesTotal} pages)`);
  } catch (e) { fail++; console.log(`  ${r.application_number}: ${e.message.slice(0, 90)}`); }
}
await writeFile(`${DIR}/manifest.json`, JSON.stringify(manifest, null, 1), 'utf-8');
console.log(`\nStaged ${ok} (${fail} failed); manifest ${manifest.length} entries, ${pagesTotal} new pages.`);
console.log(`${await countDecisionsNeedingSubject()} decision(s) still awaiting classification.`);
console.log('Next: cat petsubj-ocr.py | python -');
try { await sql.end(); } catch { /* */ }
