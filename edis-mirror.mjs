// USITC Section 337 tracker — LOCAL authenticated PDF mirror.
//
// Why this exists: EDIS's WAF 403s Vercel's serverless egress, and anonymous
// EDIS API access "cannot download any attachments" (per the EDIS guide). So the
// on-site download proxy can't work. Instead we mirror the KEY public PDFs from
// THIS machine (a normal IP EDIS accepts) using an EDIS Login.gov token, upload
// them to public Vercel Blob, and record each mirror_url in Neon. The static
// /itc-investigation page then serves View/Download straight from Blob — no
// Vercel→EDIS call, no serve-time token.
//
// Scope: "Key document types" (lib/itc-db.js KEY_DOC_PATTERNS) — complaints,
// notices of investigation, IDs, Commission opinions/notices, and remedial
// orders. Resumable (mirror_url gate) and retry-hardened.
//
// Requires in the environment (load grounds-secrets.env first):
//   POSTGRES_URL, BLOB_READ_WRITE_TOKEN, EDIS_TOKEN   (+ NODE_EXTRA_CA_CERTS on
//   an SSL-inspected network). Get EDIS_TOKEN by signing into EDIS via Login.gov
//   and copying your API token; it expires, but this job is resumable.
//
//   node edis-mirror.mjs                 # mirror all pending key docs
//   node edis-mirror.mjs --inv 337-1000  # just one investigation
//   node edis-mirror.mjs --limit 100     # cap this run
// Then: node edis-upload.mjs --derive-only   # republish per-inv blobs with mirrorUrl

import { put } from '@vercel/blob';
import { keyPublicDocsToMirror, countKeyPublicDocsToMirror, setDocumentMirror } from './lib/itc-db.js';

for (const v of ['POSTGRES_URL', 'BLOB_READ_WRITE_TOKEN', 'EDIS_TOKEN']) {
  if (!process.env[v]) { console.error(`${v} is not set. Load grounds-secrets.env (and set EDIS_TOKEN) first.`); process.exit(1); }
}

const EDIS = 'https://edis.usitc.gov/data';
const UA = 'andy-ong.com ITC-337 tracker (personal research; contact via andy-ong.com)';
const TOKEN = process.env.EDIS_TOKEN;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const args = process.argv.slice(2);
const invIdx = args.indexOf('--inv');
const INV = invIdx >= 0 ? args[invIdx + 1] : null;
const limIdx = args.indexOf('--limit');
const MAX = limIdx >= 0 ? Number(args[limIdx + 1]) : 100000;

const ENT = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" };
const decode = (s) => s == null ? null : s
  .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
  .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
  .replace(/&(amp|lt|gt|quot|apos);/g, (m) => ENT[m]);

function parseAttachments(xml) {
  const out = [];
  const re = /<attachment>([\s\S]*?)<\/attachment>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const b = m[1];
    const g = (t) => { const mm = b.match(new RegExp(`<${t}>([\\s\\S]*?)</${t}>`)); return mm ? decode(mm[1].trim()) : null; };
    out.push({ id: (g('id') || '').replace(/[^0-9]/g, ''), title: g('title'), fileSize: g('fileSize') });
  }
  return out.filter((a) => a.id);
}

async function edisFetch(url, headers, tries = 4) {
  for (let attempt = 1; attempt <= tries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 60000);
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, ...headers }, signal: ctrl.signal });
      clearTimeout(timer);
      return res;
    } catch (e) {
      clearTimeout(timer);
      if (attempt === tries) throw e;
      await sleep(1200 * attempt);
    }
  }
}

// Mirror one document: resolve its attachment(s), download the primary PDF with
// the token, upload to Blob, and return the Blob URL (or '' if nothing to fetch).
async function mirrorDoc(docId) {
  const ar = await edisFetch(`${EDIS}/attachment/${docId}`, { Accept: 'application/xml' });
  const axml = await ar.text();
  if (!ar.ok) throw new Error(`attachment lookup HTTP ${ar.status}`);
  const attachments = parseAttachments(axml);
  if (!attachments.length) return { url: '', attId: null, size: 0 };  // nothing downloadable
  const att = attachments[0];                                         // primary attachment (the document itself)

  const dr = await edisFetch(`${EDIS}/download/${docId}/${att.id}`, { Authorization: `Bearer ${TOKEN}`, Accept: 'application/pdf' });
  if (dr.status === 401 || dr.status === 403) throw new Error('EDIS_TOKEN rejected (401/403) — refresh the token');
  if (!dr.ok) throw new Error(`download HTTP ${dr.status}`);
  const buf = Buffer.from(await dr.arrayBuffer());
  if (!buf.length) throw new Error('empty download');

  const blob = await put(`itc/doc/${docId}.pdf`, buf, {
    access: 'public', contentType: 'application/pdf',
    addRandomSuffix: false, allowOverwrite: true, cacheControlMaxAge: 31536000,
  });
  return { url: blob.url, attId: att.id, size: buf.length, multi: attachments.length > 1 };
}

async function retry(fn, tries = 3) {
  for (let i = 1; ; i++) {
    try { return await fn(); }
    catch (e) {
      const msg = String((e && e.message) || e);
      if (msg.includes('token rejected') || msg.includes('token')) throw e;   // don't retry auth failures
      if (i >= tries || !/fetch failed|ECONN|ETIMEDOUT|EPIPE|socket|network|terminated|HTTP 5\d\d/i.test(msg)) throw e;
      await sleep(1000 * i);
    }
  }
}

// ── Run ────────────────────────────────────────────────────────────────
const pending = await countKeyPublicDocsToMirror(INV);
console.log(`${pending} key public document(s) pending mirror${INV ? ` for ${INV}` : ''}. Fetching up to ${Math.min(MAX, pending)}…`);
const docs = await keyPublicDocsToMirror(Math.min(MAX, pending || MAX), INV);

let ok = 0, empty = 0, failed = 0, bytes = 0; const errs = [];
for (let i = 0; i < docs.length; i++) {
  const d = docs[i];
  try {
    const r = await retry(() => mirrorDoc(d.id));
    await setDocumentMirror(d.id, r.url, r.attId, r.size);
    if (r.url) { ok++; bytes += r.size || 0; } else empty++;
  } catch (e) {
    failed++;
    const msg = String((e && e.message) || e);
    if (errs.length < 10) errs.push({ id: d.id, inv: d.investigation_number, error: msg });
    if (/token/i.test(msg)) { console.error(`\nStopping: ${msg}. Refresh EDIS_TOKEN and re-run (already-mirrored docs are skipped).`); break; }
  }
  if ((i + 1) % 10 === 0 || i === docs.length - 1) {
    process.stdout.write(`\r  ${i + 1}/${docs.length} · ${ok} mirrored (${(bytes / 1048576).toFixed(1)} MB), ${empty} no-file, ${failed} failed…`);
  }
  await sleep(300);
}
process.stdout.write('\n');
if (errs.length) console.log('Errors:', errs);
console.log(`Done: ${ok} mirrored (${(bytes / 1048576).toFixed(1)} MB), ${empty} had no downloadable file, ${failed} failed.`);
console.log(ok ? 'Next: node edis-upload.mjs --derive-only  (republish per-investigation blobs with the new mirror links)' : '');
