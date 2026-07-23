// Upload locally-OCR'd reexam determination text (snq-cumulative/text/*.txt,
// produced by grounds-ocr.py) into the site's Neon database (reexam_doc_text).
//
// Requires POSTGRES_URL in the environment (Neon connection string — Vercel
// dashboard → Storage → Neon → ".env.local", or the Neon console). Run from
// the uspto-search folder:
//     node grounds-upload.mjs            # upload everything not yet in the DB
//     node grounds-upload.mjs --limit 5  # small test run
//     node grounds-upload.mjs --force    # re-upload all (e.g. after better OCR)
//
// Filenames encode the metadata: <appNum>_<order|denial>_<date>_<docId>.txt
// Safe to re-run: rows already uploaded are skipped (unless --force).

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { sql } from '@vercel/postgres';

const TXT_DIR = 'snq-cumulative/text';

if (!process.env.POSTGRES_URL) {
  console.error('POSTGRES_URL is not set. Get the Neon connection string from the Vercel dashboard (Storage → Neon) and set it in this shell.');
  process.exit(1);
}

const args = process.argv.slice(2);
const force = args.includes('--force');
const limitIdx = args.indexOf('--limit');
const limit = limitIdx >= 0 ? Number(args[limitIdx + 1]) : null;

const files = (await readdir(TXT_DIR)).filter((f) => f.endsWith('.txt')).sort();
console.log(`${files.length} text files in ${TXT_DIR}`);

// Skip rows already uploaded (by doc_id) unless --force.
const { rows } = await sql`SELECT doc_id FROM reexam_doc_text`;
const have = new Set(rows.map((r) => r.doc_id));

let uploaded = 0, skipped = 0, failed = 0, badName = 0;
for (const f of files) {
  // <appNum>_<kind>_<YYYY-MM-DD>_<docId>.txt
  const m = f.match(/^(\d+)_([a-z]+)_(\d{4}-\d{2}-\d{2})_([0-9A-Za-z]+)\.txt$/);
  if (!m) { badName++; continue; }
  const [, appNum, kind, date, docId] = m;
  if (!force && have.has(docId)) { skipped++; continue; }
  if (limit && uploaded >= limit) break;
  try {
    const text = await readFile(path.join(TXT_DIR, f), 'utf-8');
    let meta = {};
    try { meta = JSON.parse(await readFile(path.join(TXT_DIR, f.replace(/\.txt$/, '.json')), 'utf-8')); } catch { /* sidecar optional */ }
    await sql`
      INSERT INTO reexam_doc_text (doc_id, application_number, doc_kind, official_date, ocr_engine, page_count, char_count, text)
      VALUES (${docId}, ${appNum}, ${kind}, ${date}, ${meta.engine || 'winocr'}, ${meta.pages || null}, ${text.length}, ${text})
      ON CONFLICT (doc_id) DO UPDATE SET
        ocr_engine = EXCLUDED.ocr_engine, page_count = EXCLUDED.page_count,
        char_count = EXCLUDED.char_count, text = EXCLUDED.text, uploaded_at = now()`;
    uploaded++;
    if (uploaded % 50 === 0) console.log(`  ${uploaded} uploaded…`);
  } catch (e) {
    failed++;
    console.error(`  FAIL ${f}: ${String(e.message || e).slice(0, 120)}`);
  }
}
console.log(`Done. ${uploaded} uploaded, ${skipped} already in DB, ${failed} failed, ${badName} unrecognized filenames.`);
process.exit(0);
