// Final-Office-action pass: for NIRC rows whose statement of reasons named no
// art (basis not-stated / no-nirc-art) but which have request art, stage the
// last SUBSTANTIAL Office action (RXFR.. final rejection, else the latest
// RXR.NF non-final) so the nightly session can read the operative art from it.
// The request refs (already extracted from the order) are carried in the
// manifest so the AI matches against them. Companion to oa-upload.mjs; spec in
// oa-verify.md.
//
// Requires POSTGRES_URL. Run from the uspto-search folder:
//     node oa-fetch.mjs             # default batch (25)
//     node oa-fetch.mjs --limit 200 # full bucket
//
// Output: snq-cumulative/oa-work/<app>__oa.txt   (the Office action text)
//         snq-cumulative/oa-work/pdf/            (image-only actions → preorder-ocr.py)
//         snq-cumulative/oa-work/manifest.json

import { mkdir, writeFile, rm } from 'node:fs/promises';
import { sql } from '@vercel/postgres';
import pdfParse from 'pdf-parse/lib/pdf-parse.js';
import { getNircFinalOaToProcess, cacheOaText, countNircFinalOaToProcess } from './lib/db.js';

if (!process.env.POSTGRES_URL) {
  console.error('POSTGRES_URL is not set. Load it from grounds-secrets.env first.');
  process.exit(1);
}

const args = process.argv.slice(2);
const limitIdx = args.indexOf('--limit');
const LIMIT = limitIdx >= 0 ? Number(args[limitIdx + 1]) : 25;

const SITE = 'https://andy-ong.com';
const DIR = 'snq-cumulative/oa-work';
const NUL = new RegExp(String.fromCharCode(0), 'g');
const OA_CHARS = 200000, OA_PAGES = 60;
const parseISO = (s) => { const m = String(s || '').match(/(\d{4})-?(\d{2})-?(\d{2})/); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : NaN; };

await rm(DIR, { recursive: true, force: true });
await mkdir(DIR, { recursive: true });

const rows = await getNircFinalOaToProcess(LIMIT);

// Pick the last substantial Office action: latest RXFR.. (final rejection), else
// latest RXR.NF (non-final). Returns {id, code, date} or null.
function pickAction(docs) {
  const acts = docs
    .filter((d) => d.code === 'RXFR..' || d.code === 'RXR.NF')
    .filter((d) => !isNaN(parseISO(d.date)))
    .sort((a, b) => parseISO(a.date) - parseISO(b.date));
  const finals = acts.filter((d) => d.code === 'RXFR..');
  const pool = finals.length ? finals : acts;
  return pool.length ? pool[pool.length - 1] : null;
}

async function actionText(appNum, doc, cached) {
  if (cached && cached.trim()) return cached.trim().slice(0, OA_CHARS);
  let txt = '';
  try {
    const r = await fetch(`${SITE}/api/document?appNum=${appNum}&documentId=${encodeURIComponent(doc.id)}&format=PDF&disposition=inline`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());
    const parsed = await pdfParse(buf, { max: OA_PAGES });
    txt = (parsed.text || '').replace(NUL, '').trim().slice(0, OA_CHARS);
    if (txt.length < 120) { // image-only scan → hand to preorder-ocr.py (stem must match <app>__oa.txt)
      txt = '';
      await mkdir(`${DIR}/pdf`, { recursive: true });
      await writeFile(`${DIR}/pdf/${appNum}__oa.pdf`, buf);
    }
  } catch (e) { console.error(`  ${appNum}/${doc.id}: ${e.message}`); }
  if (txt) await cacheOaText(appNum, doc.id, doc.date, doc.code, txt);
  return txt;
}

const manifest = [];
for (const row of rows) {
  const app = row.application_number;
  let bag = [];
  try {
    const r = await fetch(`${SITE}/api/application?appNum=${app}&section=documents`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    bag = (await r.json()).documentBag || [];
  } catch (e) { console.error(`${app}: documents feed failed (${e.message}) — skipped`); continue; }

  const docs = bag.map((d) => ({ id: d.documentIdentifier, code: (d.documentCode || '').toUpperCase(), date: (d.officialDate || '').slice(0, 10) }));
  const act = pickAction(docs);
  if (!act) { console.error(`${app}: no RXFR../RXR.NF action found — skipped`); continue; }
  const txt = await actionText(app, act, row.oa_text);
  await writeFile(`${DIR}/${app}__oa.txt`, txt || '(no text extracted)', 'utf-8');
  manifest.push({
    application_number: app,
    oa_doc_id: act.id, oa_code: act.code, oa_date: act.date,
    req_refs: row.req_refs || [],
    oa_file: `${app}__oa.txt`, oa_chars: (txt || '').length,
  });
  console.log(`${app}: ${act.code} ${act.date} — ${(txt || '').length}c`);
}
await writeFile(`${DIR}/manifest.json`, JSON.stringify(manifest, null, 1), 'utf-8');

console.log(`${manifest.length} action(s) staged in ${DIR} (${await countNircFinalOaToProcess()} total awaiting the final-OA pass).`);
console.log(manifest.length ? 'Next: OCR pdf/ (preorder-ocr.py oa-work 60 200000) -> verify per oa-verify.md -> node oa-upload.mjs' : 'Nothing to process.');
try { await sql.end(); } catch { /* already closed */ }
