// Stage reexam PETITION documents so the relief can be read AS FILED — from the
// petitioner's own paper rather than the Office's later decision. Two purposes:
//   1) relief for petitions with no decision yet (the majority of page rows), and
//   2) a cross-check of how the Office characterized the request.
// The relief is stated in the caption on page 1 and again in a "Relief Requested"
// / introduction section, so only the FRONT pages are needed; the rest is
// argument and exhibits. DIRECT from USPTO (zero Vercel transfer).
// Companion: petreq-ocr.py → petreq-verify.md → petreq-upload.mjs.
//
//     set -a && . ./grounds-secrets.env && set +a && node petreq-fetch.mjs [--limit N] [--dir NAME]

import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { sql } from '@vercel/postgres';
import pdfParse from 'pdf-parse/lib/pdf-parse.js';
import { fetchDocumentBytes } from './lib/uspto.js';
import { getPetitionsNeedingRequestSubject, countPetitionsNeedingRequestSubject } from './lib/db.js';

if (!process.env.POSTGRES_URL || !process.env.USPTO_API_KEY) {
  console.error('POSTGRES_URL and USPTO_API_KEY required — source grounds-secrets.env.');
  process.exit(1);
}
const args = process.argv.slice(2);
const num = (flag, def) => { const i = args.indexOf(flag); return i >= 0 ? Number(args[i + 1]) : def; };
const str = (flag, def) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : def; };
const LIMIT = num('--limit', 100000);
const DIR = `snq-cumulative/${str('--dir', 'petreq-prod')}`;

// Neon's serverless driver intermittently drops the TLS connection (ECONNRESET)
// on an otherwise fine query. A long unattended run must not die on that, so
// retry transient connection failures with backoff.
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
const rows = await retry('queue', () => getPetitionsNeedingRequestSubject(LIMIT));
console.log(`${rows.length} petition(s) need as-filed relief. Downloading (DIRECT, undecided proceedings first)…`);

let manifest = [];
try { manifest = JSON.parse(await readFile(`${DIR}/manifest.json`, 'utf-8')); } catch { /* first run */ }
const have = new Set(manifest.map((m) => m.doc_id));

let ok = 0, fail = 0, pagesTotal = 0, undecided = 0;
for (const r of rows) {
  if (have.has(r.doc_id)) { ok++; continue; }
  try {
    const { buffer } = await fetchDocumentBytes(r.application_number, r.doc_id, 'PDF', 30000);
    let pages = 0;
    try { pages = (await pdfParse(buffer)).numpages || 0; } catch { /* image-only */ }
    await writeFile(`${DIR}/pdf/${r.application_number}__${r.doc_id}.pdf`, buffer);
    manifest.push({
      application_number: r.application_number, doc_id: r.doc_id,
      petition_date: r.official_date, doc_code: r.doc_code,
      undecided: !!r.undecided, // context only; the classifier is told nothing about outcomes
      file: `${r.application_number}__${r.doc_id}.txt`, pages,
    });
    pagesTotal += pages; ok++; if (r.undecided) undecided++;
    if (ok % 25 === 0) console.log(`  …${ok}/${rows.length} staged (${pagesTotal} pages)`);
  } catch (e) { fail++; console.log(`  ${r.application_number}: ${e.message.slice(0, 90)}`); }
}
await writeFile(`${DIR}/manifest.json`, JSON.stringify(manifest, null, 1), 'utf-8');
console.log(`\nStaged ${ok} (${fail} failed); ${undecided} from proceedings with no decision yet.`);
console.log(`Manifest ${manifest.length} entries, ${pagesTotal} new pages (full docs; OCR reads only the front).`);
const left = await retry('count', () => countPetitionsNeedingRequestSubject()).catch(() => '?');
console.log(`${left} petition(s) still awaiting extraction.`);
console.log('Next: cat petreq-ocr.py | python -');
try { await sql.end(); } catch { /* */ }
