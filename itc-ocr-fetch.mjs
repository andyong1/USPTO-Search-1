// USITC Section 337 — OCR FETCH: download the scanned dispositive PDFs for the
// unclassified 337-TA investigations that have (image-only) dispositive docs, so
// itc-ocr.py can OCR them. Saves each PDF to itc-work/ocr-work/pdf/<docId>.pdf and
// writes a manifest. R2-first (public, no token) with EDIS-token fallback.
//
// Requires POSTGRES_URL, EDIS_TOKEN (+ NODE_OPTIONS=--use-system-ca). Load grounds-secrets.env.
//   node itc-ocr-fetch.mjs            # all unclassified-with-dispositive investigations
//   node itc-ocr-fetch.mjs --limit 20
//   node itc-ocr-fetch.mjs --inv 337-1000

import { mkdir, writeFile, rm } from 'node:fs/promises';
import { sql } from '@vercel/postgres';
import { documentsForDetail } from './lib/itc-db.js';
import { selectDispositive } from './lib/itc-outcome.js';

for (const v of ['POSTGRES_URL', 'EDIS_TOKEN']) { if (!process.env[v]) { console.error(`${v} is not set. Load grounds-secrets.env first.`); process.exit(1); } }

const EDIS = 'https://edis.usitc.gov/data';
const UA = 'andy-ong.com ITC-337 tracker (personal research; contact via andy-ong.com)';
const TOKEN = process.env.EDIS_TOKEN;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const args = process.argv.slice(2);
const INV = args.includes('--inv') ? args[args.indexOf('--inv') + 1] : null;
const LIMIT = args.includes('--limit') ? Number(args[args.indexOf('--limit') + 1]) : 100000;

const DIR = 'itc-work/ocr-work';
await rm(DIR, { recursive: true, force: true });
await mkdir(`${DIR}/pdf`, { recursive: true });

async function q(fn) { for (let i = 1; ; i++) { try { return await fn(); } catch (e) { if (i >= 5) throw e; await sleep(1200 * i); } } }
async function edisFetch(url, headers, tries = 4) {
  for (let a = 1; ; a++) {
    const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), 60000);
    try { const r = await fetch(url, { headers: { 'User-Agent': UA, ...headers }, signal: ctrl.signal }); clearTimeout(timer); return r; }
    catch (e) { clearTimeout(timer); if (a >= tries) throw e; await sleep(1200 * a); }
  }
}
function firstAttachmentId(xml) { const m = xml.match(/<attachment>[\s\S]*?<id>(\d+)<\/id>/); return m ? m[1] : null; }

async function pdfBuffer(docId, mirrorUrl) {
  if (mirrorUrl && /^https?:\/\//.test(mirrorUrl)) {
    const res = await edisFetch(mirrorUrl, { Accept: 'application/pdf' });
    if (!res.ok) throw new Error(`R2 GET HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }
  const ar = await edisFetch(`${EDIS}/attachment/${docId}`, { Accept: 'application/xml' });
  const axml = await ar.text();
  if (!ar.ok) throw new Error(`attachment HTTP ${ar.status}`);
  const attId = firstAttachmentId(axml);
  if (!attId) return null;
  const dr = await edisFetch(`${EDIS}/download/${docId}/${attId}`, { Authorization: `Bearer ${TOKEN}`, Accept: 'application/pdf' });
  if (dr.status === 401 || dr.status === 403) throw new Error('EDIS_TOKEN rejected (401/403) — refresh the token');
  if (!dr.ok) throw new Error(`download HTTP ${dr.status}`);
  return Buffer.from(await dr.arrayBuffer());
}

// Unclassified instituted 337-TA investigations that HAVE modern dispositive docs.
const { rows } = await q(() => sql`
  SELECT DISTINCT investigation_number FROM itc_investigation i
  WHERE public_number LIKE '337-TA-%'
    AND investigation_number NOT IN (SELECT investigation_number FROM itc_outcome WHERE ai_disposition IS NOT NULL)
    AND (${INV}::text IS NULL OR investigation_number = ${INV})
    AND investigation_number IN (SELECT DISTINCT investigation_number FROM itc_document
        WHERE document_type IN ('Opinion, Commission','ID/RD - Final on Violation','Order, Commission','ID/RD - Other Than Final on Violation'))
  ORDER BY investigation_number DESC`);
const targets = rows.map((r) => r.investigation_number).slice(0, LIMIT);
console.log(`${targets.length} unclassified investigation(s) with dispositive docs to fetch for OCR…`);

const manifest = []; let saved = 0, empty = 0, failed = 0; const errs = [];
for (const number of targets) {
  const docs = await q(() => documentsForDetail(number));
  const mir = new Map(docs.map((d) => [d.id, d.mirror_url]));
  const pub = docs.filter((d) => (d.security_level || '').toLowerCase() === 'public');
  for (const d of selectDispositive(pub)) {
    try {
      const buf = await pdfBuffer(d.id, mir.get(d.id));
      if (!buf || !buf.length) { empty++; continue; }
      await writeFile(`${DIR}/pdf/${d.id}.pdf`, buf);
      manifest.push({ docId: d.id, investigation_number: number, role: d.role, type: d.type, title: d.title, date: d.date });
      saved++;
    } catch (e) {
      failed++; const msg = String((e && e.message) || e);
      if (errs.length < 10) errs.push({ doc: d.id, inv: number, error: msg });
      if (/token/i.test(msg)) { console.error(`\nStopping: ${msg}`); break; }
    }
    await sleep(150);
  }
  if (manifest.length && manifest.length % 25 === 0) process.stdout.write(`\r  ${saved} PDFs saved…`);
}
process.stdout.write('\n');
await writeFile(`${DIR}/manifest.json`, JSON.stringify(manifest, null, 1), 'utf-8');
if (errs.length) console.log('Errors:', errs);
console.log(`Saved ${saved} PDF(s) for ${targets.length} investigation(s), ${empty} empty, ${failed} failed.`);
console.log(saved ? 'Next: cat itc-ocr.py | python -   then   node itc-ocr-upload.mjs' : 'Nothing to OCR.');
