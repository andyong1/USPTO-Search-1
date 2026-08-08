// TRNA fallback requester pass: for third-party reexams the RXOSUB.R request-doc
// pass (reqid-*) left WITHOUT a requester name, stage the Transmittal of New
// Application (doc code TRNA). The TRNA carries a structured field —
//   "The name and address of the person requesting reexamination is:"
//   <requester name> / <address>
// — which authoritatively names the requester even when the request opening did
// not. The form is image-only, so image PDFs are saved for preorder-ocr.py; only
// the front pages are needed (the field is on page 1-2). Companion to
// trnaid-upload.mjs; spec in trnaid-verify.md. Fills gaps only — never clobbers
// an existing name (see setRequesterFromTrna).
//
// Requires POSTGRES_URL. Run from the uspto-search folder:
//     node trnaid-fetch.mjs             # default 40
//     node trnaid-fetch.mjs --limit 120 # a wave
//
// Output: snq-cumulative/trnaid-work/<app>__trna.txt   (TRNA front-page text)
//         snq-cumulative/trnaid-work/pdf/               (image-only → preorder-ocr.py)
//         snq-cumulative/trnaid-work/manifest.json

import { mkdir, writeFile, rm } from 'node:fs/promises';
import { sql } from '@vercel/postgres';
import pdfParse from 'pdf-parse/lib/pdf-parse.js';
import { getReexamsMissingRequester, setRequesterFromTrna } from './lib/db.js';
import { fetchDocuments, fetchDocumentBytes } from './lib/uspto.js';

if (!process.env.POSTGRES_URL) {
  console.error('POSTGRES_URL is not set. Load it from grounds-secrets.env first.');
  process.exit(1);
}

const args = process.argv.slice(2);
const limitIdx = args.indexOf('--limit');
const LIMIT = limitIdx >= 0 ? Number(args[limitIdx + 1]) : 40;
const dirIdx = args.indexOf('--dir');
const WORKNAME = dirIdx >= 0 ? args[dirIdx + 1] : 'trnaid-work';

const DIRECT = !!process.env.USPTO_API_KEY;
const SITE = 'https://andy-ong.com';
const DIR = `snq-cumulative/${WORKNAME}`;
const NUL = new RegExp(String.fromCharCode(0), 'g');
const CHARS = 8000, PAGES = 4; // the requester field sits on the TRNA cover page
const parseISO = (s) => { const m = String(s || '').match(/(\d{4})-?(\d{2})-?(\d{2})/); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : NaN; };

async function docsBag(appNum) {
  if (DIRECT) return fetchDocuments(appNum);
  const r = await fetch(`${SITE}/api/application?appNum=${appNum}&section=documents`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return (await r.json()).documentBag || [];
}
async function pdfBuffer(appNum, docId) {
  if (DIRECT) { const b = await fetchDocumentBytes(appNum, docId, 'PDF').catch(() => null); return b ? b.buffer : null; }
  const r = await fetch(`${SITE}/api/document?appNum=${appNum}&documentId=${encodeURIComponent(docId)}&format=PDF&disposition=inline`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

// The Transmittal of New Application. Pick the earliest when more than one.
function pickTrna(docs) {
  const trnas = docs
    .filter((d) => (d.code || '').toUpperCase() === 'TRNA')
    .filter((d) => !isNaN(parseISO(d.date)))
    .sort((a, b) => parseISO(a.date) - parseISO(b.date));
  return trnas.length ? trnas[0]
    : (docs.find((d) => (d.code || '').toUpperCase() === 'TRNA') || null);
}

async function trnaText(appNum, doc) {
  let txt = '';
  try {
    const buf = await pdfBuffer(appNum, doc.id);
    if (!buf) throw new Error('download failed');
    const parsed = await pdfParse(buf, { max: PAGES });
    txt = (parsed.text || '').replace(NUL, '').trim().slice(0, CHARS);
    if (txt.length < 120) { // image-only scan → hand the cover pages to preorder-ocr.py
      txt = '';
      await mkdir(`${DIR}/pdf`, { recursive: true });
      await writeFile(`${DIR}/pdf/${appNum}__trna.pdf`, buf);
    }
  } catch (e) { console.error(`  ${appNum}/${doc.id}: ${e.message}`); }
  return txt;
}

await rm(DIR, { recursive: true, force: true });
await mkdir(DIR, { recursive: true });

console.log(`Fetch mode: ${DIRECT ? 'DIRECT from USPTO (no Vercel transfer)' : 'via /api proxy'} — reading up to ${PAGES} pages.`);
const rows = await getReexamsMissingRequester(LIMIT);

const manifest = [];
let staged = 0, noTrna = 0;
for (const row of rows) {
  const app = row.application_number;
  let bag = [];
  try {
    bag = await docsBag(app);
  } catch (e) { console.error(`${app}: documents feed failed (${e.message}) — skipped`); continue; }

  const docs = bag.map((d) => ({ id: d.documentIdentifier, code: (d.documentCode || '').toUpperCase(), date: (d.officialDate || '').slice(0, 10) }));
  const trna = pickTrna(docs);
  if (!trna) {
    // Stamp req_code='TRNA' (no name) so this proceeding is not re-pulled every
    // run — there is no TRNA to read. Gap-fill guard leaves any existing name.
    await setRequesterFromTrna(app, { requester_name: null, docId: null, date: null, confidence: 'low', note: 'no TRNA document on file' });
    noTrna++; console.log(`${app}: no TRNA doc — marked`); continue;
  }

  const txt = await trnaText(app, trna);
  await writeFile(`${DIR}/${app}__trna.txt`, txt || '(no text extracted)', 'utf-8');
  manifest.push({ application_number: app, trna_doc_id: trna.id, trna_date: trna.date, trna_file: `${app}__trna.txt`, chars: (txt || '').length });
  staged++;
  console.log(`${app}: TRNA ${trna.date} — ${(txt || '').length}c`);
}

await writeFile(`${DIR}/manifest.json`, JSON.stringify(manifest, null, 2), 'utf-8');
console.log(`\nStaged ${staged} TRNA doc(s); ${noTrna} had none. (${rows.length} missing-requester reexam(s) pulled this wave.)`);
console.log(staged ? 'Next: OCR image-only PDFs (cat preorder-ocr.py | python - trnaid-work 4 8000), then follow trnaid-verify.md → trnaid-upload.mjs.' : 'Nothing to analyze.');
try { await sql.end(); } catch { /* already closed */ }
