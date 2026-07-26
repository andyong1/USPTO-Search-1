// Fill the /reexam-nirc Outcome column for NIRCs whose certificate hasn't issued
// (outcome_summary blank). Stages the NIRC's first pages — the PTOL-469 cover
// form states the claim disposition — for the nightly session to read.
// Companion to ocfill-upload.mjs; spec in ocfill-verify.md.
//
// Requires POSTGRES_URL. Run from the uspto-search folder:
//     node ocfill-fetch.mjs             # default 25
//     node ocfill-fetch.mjs --limit 250 # full set
//
// Output: snq-cumulative/oc-work/<app>__nirc.txt  +  manifest.json

import { mkdir, writeFile, rm } from 'node:fs/promises';
import { sql } from '@vercel/postgres';
import pdfParse from 'pdf-parse/lib/pdf-parse.js';
import { getNircOutcomesToFill, countNircOutcomesToFill } from './lib/db.js';

if (!process.env.POSTGRES_URL) {
  console.error('POSTGRES_URL is not set. Load it from grounds-secrets.env first.');
  process.exit(1);
}

const args = process.argv.slice(2);
const limitIdx = args.indexOf('--limit');
const LIMIT = limitIdx >= 0 ? Number(args[limitIdx + 1]) : 25;

const SITE = 'https://andy-ong.com';
const DIR = 'snq-cumulative/oc-work';
const NUL = new RegExp(String.fromCharCode(0), 'g');
const PAGES = 4, CHARS = 8000; // the disposition is on the cover pages

await rm(DIR, { recursive: true, force: true });
await mkdir(DIR, { recursive: true });

const rows = await getNircOutcomesToFill(LIMIT);
const manifest = [];
for (const r of rows) {
  const app = r.application_number;
  let txt = '';
  try {
    const res = await fetch(`${SITE}/api/document?appNum=${app}&documentId=${encodeURIComponent(r.nirc_doc_id)}&format=PDF&disposition=inline`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const parsed = await pdfParse(buf, { max: PAGES });
    txt = (parsed.text || '').replace(NUL, '').trim().slice(0, CHARS);
    if (txt.length < 120) { // image-only → OCR (stem must match <app>__nirc.txt)
      txt = '';
      await mkdir(`${DIR}/pdf`, { recursive: true });
      await writeFile(`${DIR}/pdf/${app}__nirc.pdf`, buf);
    }
  } catch (e) { console.error(`  ${app}: ${e.message}`); }
  await writeFile(`${DIR}/${app}__nirc.txt`, txt || '(no text extracted)', 'utf-8');
  manifest.push({ application_number: app, nirc_doc_id: r.nirc_doc_id, file: `${app}__nirc.txt` });
  console.log(`${app}: ${(txt || '').length}c`);
}
await writeFile(`${DIR}/manifest.json`, JSON.stringify(manifest, null, 1), 'utf-8');
console.log(`${manifest.length} NIRC(s) staged in ${DIR} (${await countNircOutcomesToFill()} total blank outcomes).`);
console.log(manifest.length ? 'Next: OCR pdf/ (preorder-ocr.py oc-work 4 8000) -> verify per ocfill-verify.md -> node ocfill-upload.mjs' : 'Nothing to fill.');
try { await sql.end(); } catch { /* already closed */ }
