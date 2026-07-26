// Stage NIRC prior-art comparison work for the nightly Claude session: for each
// concluded reexam with a NIRC, the reexam ORDER text (already stored — the
// request-side art source) plus the NIRC text (fetched + cached here). The AI
// then extracts the order's SNQ art and the NIRC's discussed art (by role) and
// matches them, per nirc-verify.md. Companion to nirc-upload.mjs.
//
// Requires POSTGRES_URL in the environment (grounds-secrets.env). Run from the
// uspto-search folder:
//     node nirc-fetch.mjs             # default batch (25, newest NIRC first)
//     node nirc-fetch.mjs --limit 600 # full backfill
//
// Output: snq-cumulative/nirc-work/<app>__order.txt   (order/request art source)
//         snq-cumulative/nirc-work/<app>__nirc.txt     (NIRC text)
//         snq-cumulative/nirc-work/pdf/                (image-only NIRCs → preorder-ocr.py)
//         snq-cumulative/nirc-work/manifest.json

import { mkdir, writeFile, rm } from 'node:fs/promises';
import { sql } from '@vercel/postgres';
import pdfParse from 'pdf-parse/lib/pdf-parse.js';
import { getNircToAi, cacheNircText, countNircToAi } from './lib/db.js';

if (!process.env.POSTGRES_URL) {
  console.error('POSTGRES_URL is not set. Load it from grounds-secrets.env first.');
  process.exit(1);
}

const args = process.argv.slice(2);
const limitIdx = args.indexOf('--limit');
const LIMIT = limitIdx >= 0 ? Number(args[limitIdx + 1]) : 25;

const SITE = 'https://andy-ong.com';
const DIR = 'snq-cumulative/nirc-work';
const NUL = new RegExp(String.fromCharCode(0), 'g');
const ORDER_CHARS = 20000;  // orders recite SNQs early; generous head slice
// NIRCs are captured in FULL — the statement of reasons can run past the cover
// form and, in long confirmations, past page 20. No practical cap (real NIRCs
// top out ~25 pages); the AI reads the whole reasons section.
const NIRC_CHARS = 200000;
const NIRC_PAGES = 60;

await rm(DIR, { recursive: true, force: true }); // stale work must not be re-verified
await mkdir(DIR, { recursive: true });

const rows = await getNircToAi(LIMIT);

async function nircText(appNum, docId, date, cached) {
  if (cached && cached.trim()) return cached.trim().slice(0, NIRC_CHARS);
  let txt = '';
  try {
    const r = await fetch(`${SITE}/api/document?appNum=${appNum}&documentId=${encodeURIComponent(docId)}&format=PDF&disposition=inline`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());
    const parsed = await pdfParse(buf, { max: NIRC_PAGES });
    txt = (parsed.text || '').replace(NUL, '').trim().slice(0, NIRC_CHARS);
    if (txt.length < 120) { // image-only scan — hand off to the local OCR step.
      // PDF stem MUST match the staged text file (<app>__nirc.txt) so
      // preorder-ocr.py overwrites the right file.
      txt = '';
      await mkdir(`${DIR}/pdf`, { recursive: true });
      await writeFile(`${DIR}/pdf/${appNum}__nirc.pdf`, buf);
    }
  } catch (e) {
    console.error(`  ${appNum}/${docId}: ${e.message}`);
  }
  if (txt) await cacheNircText(appNum, docId, date, txt);
  return txt;
}

const manifest = [];
for (const row of rows) {
  const app = row.application_number;
  const orderText = (row.order_text || '').replace(NUL, '').trim().slice(0, ORDER_CHARS);
  const nirc = await nircText(app, row.nirc_doc_id, row.nirc_date, row.nirc_text);
  await writeFile(`${DIR}/${app}__order.txt`, orderText || '(no order text)', 'utf-8');
  await writeFile(`${DIR}/${app}__nirc.txt`, nirc || '(no text extracted)', 'utf-8');
  manifest.push({
    application_number: app,
    nirc_doc_id: row.nirc_doc_id,
    nirc_date: row.nirc_date,
    outcome_summary: row.outcome_summary || '',
    order_file: `${app}__order.txt`, order_chars: orderText.length,
    nirc_file: `${app}__nirc.txt`, nirc_chars: nirc.length,
  });
  console.log(`${app}: order ${orderText.length}c, NIRC ${nirc.length}c`);
}
await writeFile(`${DIR}/manifest.json`, JSON.stringify(manifest, null, 1), 'utf-8');

console.log(`${manifest.length} proceeding(s) staged in ${DIR} (${await countNircToAi()} total awaiting AI analysis).`);
console.log(manifest.length ? 'Next: OCR pdf/ leftovers (preorder-ocr.py nirc-work) -> verify per nirc-verify.md -> node nirc-upload.mjs' : 'Nothing to analyze.');
try { await sql.end(); } catch { /* already closed */ }
