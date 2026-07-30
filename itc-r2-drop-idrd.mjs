// USITC Section 337 tracker — one-time R2 cleanup: DROP the mirrored ID/RD PDFs.
//
// The ALJ's Initial/Recommended Determinations are the single largest slice of the
// mirror (~3.2 GB, avg ~9 MB each). Their TEXT is already extracted to itc_doc_text
// (the basis for the AI outcome + holding summary), so the PDF is redundant for our
// analytics. The outcome column links opinions and orders — NOT IDs — so dropping
// the ID PDFs breaks no outcome-column link; it only turns the detail-page ID
// download button into an "On EDIS" fallback.
//
// Deletes each mirrored ID/RD PDF from R2, clears mirror_url to '' (so the detail
// page falls back to "On EDIS" and a future edis-mirror run won't re-fetch it),
// and republishes the touched investigations' detail blobs.
//
// NOTE: if you later bump EXTRACT_V and re-OCR, the IDs would need re-mirroring
// first (same caveat as itc-r2-drop-noi.mjs). Extracted text is untouched here.
//
// Requires POSTGRES_URL, BLOB_READ_WRITE_TOKEN, R2_ACCOUNT_ID, R2_ACCESS_KEY_ID,
// R2_SECRET_ACCESS_KEY, R2_BUCKET (+ NODE_OPTIONS=--use-system-ca). Load grounds-secrets.env.
//   node itc-r2-drop-idrd.mjs --dry     # count + size only, no deletes
//   node itc-r2-drop-idrd.mjs           # delete for real

import { AwsClient } from 'aws4fetch';
import { sql } from '@vercel/postgres';
import { setDocumentMirror } from './lib/itc-db.js';
import { loadCatalogMaps, publishInvestigationDocs } from './lib/itc-publish.js';

const NEED = ['POSTGRES_URL', 'BLOB_READ_WRITE_TOKEN', 'R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET'];
for (const v of NEED) { if (!process.env[v]) { console.error(`${v} is not set. Load grounds-secrets.env first.`); process.exit(1); } }

const DRY = process.argv.includes('--dry');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const r2 = new AwsClient({ accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY, region: 'auto', service: 's3' });
const R2_ENDPOINT = `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${process.env.R2_BUCKET}`;

async function q(fn) { for (let i = 1; ; i++) { try { return await fn(); } catch (e) { if (i >= 5) throw e; await sleep(1200 * i); } } }

const { rows } = await q(() => sql`
  SELECT id, investigation_number, mirror_size FROM itc_document
  WHERE mirror_url LIKE 'http%'
    AND document_type ~* 'ID/RD|Initial Determination'`);
const gb = (rows.reduce((s, r) => s + (Number(r.mirror_size) || 0), 0) / 1073741824).toFixed(2);
console.log(`${rows.length} mirrored ID/RD PDF(s) to drop, ~${gb} GB.`);
if (DRY) { console.log('(dry run — no deletes)'); process.exit(0); }

let del = 0, failed = 0; const touched = new Set(); const errs = [];
for (const d of rows) {
  try {
    const res = await r2.fetch(`${R2_ENDPOINT}/itc/doc/${d.id}.pdf`, { method: 'DELETE' });
    if (!res.ok && res.status !== 404) throw new Error(`R2 DELETE HTTP ${res.status}`);
    await q(() => setDocumentMirror(d.id, '', null, null));   // '' = dropped; detail page → "On EDIS"
    del++; touched.add(d.investigation_number);
  } catch (e) { failed++; if (errs.length < 10) errs.push({ id: d.id, error: String((e && e.message) || e) }); }
  if (del % 50 === 0) process.stdout.write(`\r  deleted ${del}/${rows.length}…`);
  await sleep(60);
}
process.stdout.write('\n');
if (errs.length) console.log('Errors:', errs);
console.log(`Deleted ${del} ID/RD PDF(s) from R2, ${failed} failed.`);

// Republish the touched investigations' detail blobs so the ID now shows "On EDIS".
let metaByNumber = new Map();
try { ({ metaByNumber } = await loadCatalogMaps('itc-work')); } catch { /* header meta optional */ }
let rp = 0;
for (const number of touched) {
  try { await publishInvestigationDocs(number, metaByNumber.get(number)); rp++; }
  catch (e) { if (errs.length < 20) errs.push({ number, error: `republish: ${(e && e.message) || e}` }); }
  if (rp % 50 === 0) process.stdout.write(`\r  republished ${rp}/${touched.size}…`);
}
process.stdout.write('\n');
console.log(`Republished ${rp} detail blob(s). R2 should now be ~${gb} GB lighter.`);
