// Requester-identity pass: stage each third-party reexam's REQUEST document
// (doc code RXOSUB.R* — "Receipt of Original Ex Parte Request by Third Party")
// so the nightly session can read the authoritative requester from its opening
// ("... X ('Requester') submits/requests this ex parte reexamination ..."). The
// request is image-only, so image PDFs are saved for preorder-ocr.py. Only the
// front pages are needed (the requester + real-party statement is up front).
// Companion to reqid-upload.mjs; spec in reqid-verify.md.
//
// Requires POSTGRES_URL. Run from the uspto-search folder:
//     node reqid-fetch.mjs             # default 25
//     node reqid-fetch.mjs --limit 400 # a wave
//
// Output: snq-cumulative/reqid-work/<app>__req.txt   (request front-page text)
//         snq-cumulative/reqid-work/pdf/              (image-only → preorder-ocr.py)
//         snq-cumulative/reqid-work/manifest.json

import { mkdir, writeFile, rm } from 'node:fs/promises';
import { sql } from '@vercel/postgres';
import pdfParse from 'pdf-parse/lib/pdf-parse.js';
import { getReexamsNeedingRequester, cacheRequesterText, markNoRequestDoc, countReexamsNeedingRequester } from './lib/db.js';
import { fetchDocuments, fetchDocumentBytes } from './lib/uspto.js';

if (!process.env.POSTGRES_URL) {
  console.error('POSTGRES_URL is not set. Load it from grounds-secrets.env first.');
  process.exit(1);
}

const args = process.argv.slice(2);
const limitIdx = args.indexOf('--limit');
const LIMIT = limitIdx >= 0 ? Number(args[limitIdx + 1]) : 25;
// --dir lets a manual bulk backfill use its own work folder so it can't collide
// with the nightly step's reqid-work (whose rm -rf would clobber it mid-run).
const dirIdx = args.indexOf('--dir');
const WORKNAME = dirIdx >= 0 ? args[dirIdx + 1] : 'reqid-work';

// DIRECT mode (USPTO_API_KEY present): download straight from USPTO to this
// machine — no Vercel Fast Origin Transfer, and we can read more pages freely.
// Otherwise fall back to the public /api/document proxy.
const DIRECT = !!process.env.USPTO_API_KEY;
const SITE = 'https://andy-ong.com';
const DIR = `snq-cumulative/${WORKNAME}`;
const NUL = new RegExp(String.fromCharCode(0), 'g');
const CHARS = 30000, PAGES = 20; // read well into the request (requester may sit past the cover / in a later signature block)
const parseISO = (s) => { const m = String(s || '').match(/(\d{4})-?(\d{2})-?(\d{2})/); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : NaN; };

// Documents feed + document PDF, either direct from USPTO (local key) or via the proxy.
async function docsBag(appNum) {
  if (DIRECT) return fetchDocuments(appNum); // normalized {documentIdentifier, documentCode, officialDate, …}
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

await rm(DIR, { recursive: true, force: true });
await mkdir(DIR, { recursive: true });

console.log(`Fetch mode: ${DIRECT ? 'DIRECT from USPTO (no Vercel transfer)' : 'via /api proxy'} — reading up to ${PAGES} pages.`);
const rows = await getReexamsNeedingRequester(LIMIT);

// The third-party request document: RXOSUB.R / RXOSUB.R.40 / RXO_40.R. Pick the
// earliest (the original request) when more than one is present.
function pickRequest(docs) {
  const reqs = docs
    .filter((d) => /^RXOSUB\.R|^RXO_\d+\.R/i.test((d.code || '').toUpperCase()))
    .filter((d) => !isNaN(parseISO(d.date)))
    .sort((a, b) => parseISO(a.date) - parseISO(b.date));
  return reqs.length ? reqs[0]
    : (docs.find((d) => /^RXOSUB\.R|^RXO_\d+\.R/i.test((d.code || '').toUpperCase())) || null);
}

async function reqText(appNum, doc, cached) {
  if (cached && cached.trim()) return cached.trim().slice(0, CHARS);
  let txt = '';
  try {
    const buf = await pdfBuffer(appNum, doc.id);
    if (!buf) throw new Error('download failed');
    const parsed = await pdfParse(buf, { max: PAGES });
    txt = (parsed.text || '').replace(NUL, '').trim().slice(0, CHARS);
    if (txt.length < 120) { // image-only scan → hand the first pages to preorder-ocr.py
      txt = '';
      await mkdir(`${DIR}/pdf`, { recursive: true });
      await writeFile(`${DIR}/pdf/${appNum}__req.pdf`, buf);
    }
  } catch (e) { console.error(`  ${appNum}/${doc.id}: ${e.message}`); }
  if (txt) await cacheRequesterText(appNum, doc.id, doc.date, doc.code, txt);
  return txt;
}

const manifest = [];
let staged = 0, noReq = 0;
for (const row of rows) {
  const app = row.application_number;
  let bag = [];
  try {
    bag = await docsBag(app);
  } catch (e) { console.error(`${app}: documents feed failed (${e.message}) — skipped`); continue; }

  const docs = bag.map((d) => ({ id: d.documentIdentifier, code: (d.documentCode || '').toUpperCase(), date: (d.officialDate || '').slice(0, 10) }));
  const req = pickRequest(docs);
  if (!req) { await markNoRequestDoc(app); noReq++; console.log(`${app}: no request doc — marked`); continue; }

  const cached = row.req_doc_id === req.id ? row.req_text : '';
  const txt = await reqText(app, req, cached);
  await cacheRequesterText(app, req.id, req.date, req.code, txt || null); // record identity even when image-only
  await writeFile(`${DIR}/${app}__req.txt`, txt || '(no text extracted)', 'utf-8');
  manifest.push({ application_number: app, req_doc_id: req.id, req_date: req.date, req_code: req.code, req_file: `${app}__req.txt`, chars: (txt || '').length });
  staged++;
  console.log(`${app}: ${req.code} ${req.date} — ${(txt || '').length}c`);
}

await writeFile(`${DIR}/manifest.json`, JSON.stringify(manifest, null, 2), 'utf-8');
const awaiting = await countReexamsNeedingRequester();
console.log(`\nStaged ${staged} request doc(s); ${noReq} had none. ${awaiting} third-party reexam(s) still awaiting requester extraction.`);
console.log(staged ? 'Next: OCR image-only PDFs, then follow reqid-verify.md → reqid-upload.mjs.' : 'Nothing to analyze.');
try { await sql.end(); } catch { /* already closed */ }
