// USITC Section 337 tracker — LOCAL authenticated PDF mirror to Cloudflare R2.
//
// EDIS 403s Vercel's serverless egress and anonymous EDIS can't download
// attachments, and the EDIS website now requires a cumbersome Login.gov sign-in
// to download. So we mirror the KEY public PDFs from THIS machine (a normal IP,
// with your EDIS token) to Cloudflare R2 (10 GB free + free egress), record each
// public R2 URL in Neon (itc_document.mirror_url), and the /itc-investigation
// page serves View/Download straight from R2 — no EDIS login for visitors.
//
// Scope (lib/itc-outcome.js selectMirrorDocs): the dispositive set (Commission
// opinion, final ID, remedy/consent orders + latest FR notice) plus the complaint
// and notice of investigation — public only, type-driven (no procedural flood).
// Per-file size cap skips giant exhibit bundles. Resumable (mirror_url gate).
//
// Requires (load grounds-secrets.env first):
//   POSTGRES_URL, EDIS_TOKEN, BLOB_READ_WRITE_TOKEN (to republish detail blobs),
//   R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET, R2_PUBLIC_BASE
//   (+ NODE_OPTIONS=--use-system-ca on the corporate network).
//
//   node edis-mirror.mjs                 # mirror all investigations (newest first)
//   node edis-mirror.mjs --inv 337-1000  # just one investigation
//   node edis-mirror.mjs --limit 100     # cap to N investigations this run
// Republishes the affected detail blobs itself — mirror links go live immediately.

import { AwsClient } from 'aws4fetch';
import { numbersWithDocuments, documentsForDetail, setDocumentMirror } from './lib/itc-db.js';
import { selectMirrorDocs } from './lib/itc-outcome.js';
import { loadCatalogMaps, publishInvestigationDocs } from './lib/itc-publish.js';

const NEED = ['POSTGRES_URL', 'EDIS_TOKEN', 'BLOB_READ_WRITE_TOKEN', 'R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET', 'R2_PUBLIC_BASE'];
for (const v of NEED) { if (!process.env[v]) { console.error(`${v} is not set. Load grounds-secrets.env (with the R2 + EDIS credentials) first.`); process.exit(1); } }

const EDIS = 'https://edis.usitc.gov/data';
const UA = 'andy-ong.com ITC-337 tracker (personal research; contact via andy-ong.com)';
const TOKEN = process.env.EDIS_TOKEN;
const MAX_BYTES = 40 * 1048576;   // skip attachments larger than 40 MB (exhibit bundles)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const args = process.argv.slice(2);
const INV = args.includes('--inv') ? args[args.indexOf('--inv') + 1] : null;
const MAX = args.includes('--limit') ? Number(args[args.indexOf('--limit') + 1]) : 100000;
// Recency window: mirror only investigations instituted (earliest document) in
// this year or later — keeps R2 within the 10 GB free tier (~5.7 GB at 2015,
// with headroom for new filings; older docs still link to EDIS). --since 0 = all.
const SINCE = args.includes('--since') ? Number(args[args.indexOf('--since') + 1]) : 2015;

// R2 (S3-compatible) via aws4fetch (tiny SigV4 signer).
const r2 = new AwsClient({ accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY, region: 'auto', service: 's3' });
const R2_ENDPOINT = `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${process.env.R2_BUCKET}`;
const R2_PUBLIC = process.env.R2_PUBLIC_BASE.replace(/\/$/, '');
async function r2Put(key, buf, contentType) {
  const res = await r2.fetch(`${R2_ENDPOINT}/${key}`, { method: 'PUT', body: buf, headers: { 'Content-Type': contentType } });
  if (!res.ok) throw new Error(`R2 PUT HTTP ${res.status}`);
  return `${R2_PUBLIC}/${key}`;
}

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
  for (let attempt = 1; ; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 60000);
    try { const res = await fetch(url, { headers: { 'User-Agent': UA, ...headers }, signal: ctrl.signal }); clearTimeout(timer); return res; }
    catch (e) { clearTimeout(timer); if (attempt >= tries) throw e; await sleep(1200 * attempt); }
  }
}

// Resolve the primary attachment, download the PDF with the token, upload to R2.
// Returns {url,attId,size}; url '' when there's nothing to fetch or it's too big.
async function mirrorDoc(docId) {
  const ar = await edisFetch(`${EDIS}/attachment/${docId}`, { Accept: 'application/xml' });
  const axml = await ar.text();
  if (!ar.ok) throw new Error(`attachment lookup HTTP ${ar.status}`);
  const attachments = parseAttachments(axml);
  if (!attachments.length) return { url: '', attId: null, size: 0 };
  const att = attachments[0];
  if (att.fileSize && Number(att.fileSize) > MAX_BYTES) return { url: '', attId: att.id, size: Number(att.fileSize), tooBig: true };

  const dr = await edisFetch(`${EDIS}/download/${docId}/${att.id}`, { Authorization: `Bearer ${TOKEN}`, Accept: 'application/pdf' });
  if (dr.status === 401 || dr.status === 403) throw new Error('EDIS_TOKEN rejected (401/403) — refresh the token');
  if (!dr.ok) throw new Error(`download HTTP ${dr.status}`);
  const buf = Buffer.from(await dr.arrayBuffer());
  if (!buf.length) throw new Error('empty download');
  if (buf.length > MAX_BYTES) return { url: '', attId: att.id, size: buf.length, tooBig: true };

  const url = await r2Put(`itc/doc/${docId}.pdf`, buf, 'application/pdf');
  return { url, attId: att.id, size: buf.length };
}

async function retry(fn, tries = 3) {
  for (let i = 1; ; i++) {
    try { return await fn(); }
    catch (e) {
      const msg = String((e && e.message) || e);
      if (/token/i.test(msg)) throw e;   // don't retry auth failures
      if (i >= tries || !/fetch failed|ECONN|ETIMEDOUT|EPIPE|socket|network|terminated|HTTP 5\d\d|R2 PUT HTTP 5/i.test(msg)) throw e;
      await sleep(1000 * i);
    }
  }
}

// ── Run ────────────────────────────────────────────────────────────────
const invNum = (n) => parseInt(String(n || '').match(/(\d+)$/)?.[1] || '0', 10);
let numbers = INV ? [INV] : (await numbersWithDocuments()).sort((a, b) => invNum(b) - invNum(a));
if (!INV) numbers = numbers.slice(0, MAX);
console.log(`Mirroring key documents for ${numbers.length} investigation(s) to R2 (${R2_PUBLIC})${INV || !SINCE ? '' : `, instituted >= ${SINCE}`}…`);

let ok = 0, empty = 0, big = 0, skipped = 0, failed = 0, oldSkip = 0, bytes = 0, i = 0; const errs = [];
const touched = new Set();
let stop = false;
for (const number of numbers) {
  i++;
  if (stop) break;
  let docs;
  try { docs = await documentsForDetail(number); }
  catch (e) { failed++; if (errs.length < 10) errs.push({ inv: number, error: String((e && e.message) || e) }); continue; }
  // Recency gate: skip investigations instituted before SINCE (earliest doc date).
  if (!INV && SINCE) {
    const dates = docs.map((d) => String(d.received_date || '')).filter(Boolean).sort();
    const year = dates[0] ? Number(dates[0].slice(0, 4)) : 0;
    if (year && year < SINCE) { oldSkip++; continue; }
  }
  const done = new Set(docs.filter((d) => d.mirror_url != null).map((d) => d.id)); // '' (tried) or url (mirrored)
  for (const s of selectMirrorDocs(docs)) {
    if (done.has(s.id)) { skipped++; continue; }
    try {
      const r = await retry(() => mirrorDoc(s.id));
      await setDocumentMirror(s.id, r.url, r.attId, r.size);
      if (r.url) { ok++; bytes += r.size || 0; touched.add(number); }
      else if (r.tooBig) big++;
      else empty++;
    } catch (e) {
      failed++;
      const msg = String((e && e.message) || e);
      if (errs.length < 10) errs.push({ id: s.id, inv: number, error: msg });
      if (/token/i.test(msg)) { console.error(`\nStopping: ${msg}. Refresh EDIS_TOKEN and re-run (mirrored docs are skipped).`); stop = true; break; }
    }
    await sleep(250);
  }
  if (i % 10 === 0 || i === numbers.length) process.stdout.write(`\r  ${i}/${numbers.length} inv · ${ok} mirrored (${(bytes / 1048576).toFixed(0)} MB), ${big} too-big, ${empty} no-file, ${skipped} done, ${failed} failed…`);
}
process.stdout.write('\n');
if (errs.length) console.log('Errors:', errs);
console.log(`Done: ${ok} mirrored (${(bytes / 1048576).toFixed(0)} MB), ${big} too big (>40MB, skipped), ${empty} no downloadable file, ${skipped} already done, ${oldSkip} pre-${SINCE} investigations skipped, ${failed} failed.`);

// Republish ONLY the touched investigations' detail blobs so the R2 links go live.
if (touched.size) {
  let metaByNumber = new Map();
  try { ({ metaByNumber } = await loadCatalogMaps('itc-work')); } catch { /* header meta optional */ }
  let rp = 0;
  for (const number of touched) {
    try { await publishInvestigationDocs(number, metaByNumber.get(number)); rp++; }
    catch (e) { console.error(`  republish ${number} failed: ${(e && e.message) || e}`); }
  }
  console.log(`Republished ${rp} investigation detail blob(s) with R2 mirror links.`);
}
