// USITC Section 337 tracker — Phase 2 dispositive-text EXTRACTION (local).
//
// For each investigation with dispositive documents, select the small terminal
// set (Commission opinion, final ID, remedy/consent orders, Commission notices),
// download each PUBLIC PDF locally with the EDIS token, extract its text
// (pdf-parse; scanned docs are flagged for a later OCR pass), cap it head+tail,
// and store in itc_doc_text. The PDF is discarded — text into Neon, nothing into
// Blob. Resumable (already-extracted docs skipped) and versioned (EXTRACT_V).
//
// Requires: POSTGRES_URL, EDIS_TOKEN (+ NODE_EXTRA_CA_CERTS on an SSL-inspected
// network). Load grounds-secrets.env first.
//
//   node itc-text.mjs                 # extract all pending (concluded) investigations
//   node itc-text.mjs --inv 337-1000  # one investigation
//   node itc-text.mjs --limit 50      # cap this run
//
// Next: node itc-outcome-fetch.mjs  (stage for the nightly AI classify pass)

import pdfParse from 'pdf-parse/lib/pdf-parse.js';
import {
  investigationsToExtract, documentsForDetail, extractedDocIds, upsertDocText,
} from './lib/itc-db.js';
import { selectDispositive } from './lib/itc-outcome.js';

for (const v of ['POSTGRES_URL', 'EDIS_TOKEN']) {
  if (!process.env[v]) { console.error(`${v} is not set. Load grounds-secrets.env (and set EDIS_TOKEN) first.`); process.exit(1); }
}

const EXTRACT_V = 1;              // bump to force re-extraction of every dispositive doc
const HEAD = 40000, TAIL = 20000; // per-doc text cap (holding/order sits at the tail)
const EDIS = 'https://edis.usitc.gov/data';
const UA = 'andy-ong.com ITC-337 tracker (personal research; contact via andy-ong.com)';
const TOKEN = process.env.EDIS_TOKEN;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const args = process.argv.slice(2);
const INV = args.includes('--inv') ? args[args.indexOf('--inv') + 1] : null;
const MAX = args.includes('--limit') ? Number(args[args.indexOf('--limit') + 1]) : 100000;

const ENT = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" };
const decode = (s) => s == null ? null : s
  .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
  .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
  .replace(/&(amp|lt|gt|quot|apos);/g, (m) => ENT[m]);

function firstAttachmentId(xml) {
  const m = xml.match(/<attachment>[\s\S]*?<id>(\d+)<\/id>/);
  return m ? m[1] : null;
}

async function edisFetch(url, headers, tries = 4) {
  for (let attempt = 1; ; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 60000);
    try { const res = await fetch(url, { headers: { 'User-Agent': UA, ...headers }, signal: ctrl.signal }); clearTimeout(timer); return res; }
    catch (e) { clearTimeout(timer); if (attempt >= tries) throw e; await sleep(1200 * attempt); }
  }
}

function capText(s) {
  if (s.length <= HEAD + TAIL) return s;
  return `${s.slice(0, HEAD)}\n\n…[${s.length - HEAD - TAIL} characters omitted]…\n\n${s.slice(-TAIL)}`;
}

// Resolve the primary attachment, download the PDF with the token, extract text.
async function extractDoc(docId) {
  const ar = await edisFetch(`${EDIS}/attachment/${docId}`, { Accept: 'application/xml' });
  const axml = await ar.text();
  if (!ar.ok) throw new Error(`attachment lookup HTTP ${ar.status}`);
  const attId = firstAttachmentId(decode(axml) || axml);
  if (!attId) return { source: 'none', text: '', chars: 0 };

  const dr = await edisFetch(`${EDIS}/download/${docId}/${attId}`, { Authorization: `Bearer ${TOKEN}`, Accept: 'application/pdf' });
  if (dr.status === 401 || dr.status === 403) throw new Error('EDIS_TOKEN rejected (401/403) — refresh the token');
  if (!dr.ok) throw new Error(`download HTTP ${dr.status}`);
  const buf = Buffer.from(await dr.arrayBuffer());
  if (!buf.length) throw new Error('empty download');

  let parsed;
  try { parsed = await pdfParse(buf); }
  catch (e) { return { source: 'parse-error', text: '', chars: 0, note: String(e.message || e) }; }
  const text = (parsed.text || '').trim();
  // A born-digital doc yields lots of text; near-empty over multiple pages = scanned.
  if (text.length < 200 && (parsed.numpages || 1) >= 1) return { source: 'scanned', text: '', chars: 0 };
  return { source: 'pdf', text: capText(text), chars: text.length };
}

async function retry(fn, tries = 3) {
  for (let i = 1; ; i++) {
    try { return await fn(); }
    catch (e) {
      const msg = String((e && e.message) || e);
      if (/token rejected|EDIS_TOKEN/.test(msg)) throw e;
      if (i >= tries || !/fetch failed|ECONN|ETIMEDOUT|EPIPE|socket|network|terminated|HTTP 5\d\d/i.test(msg)) throw e;
      await sleep(1000 * i);
    }
  }
}

// ── Run ────────────────────────────────────────────────────────────────
const targets = await investigationsToExtract(MAX, INV);
console.log(`${targets.length} investigation(s) with dispositive documents to process${INV ? ` (${INV})` : ''}.`);

let invDone = 0, extracted = 0, scanned = 0, skipped = 0, failed = 0, chars = 0; const errs = [];
for (const number of targets) {
  invDone++;
  try {
    const docs = await documentsForDetail(number);
    const publicDocs = docs.filter((d) => (d.security_level || '').toLowerCase() === 'public');
    const selected = selectDispositive(publicDocs);
    const already = await extractedDocIds(number, EXTRACT_V);
    for (const d of selected) {
      if (already.has(d.id)) { skipped++; continue; }
      try {
        const r = await retry(() => extractDoc(d.id));
        await upsertDocText({ docId: d.id, number, role: d.role, type: d.type, title: d.title, date: d.date, text: r.text, charCount: r.chars, source: r.source, v: EXTRACT_V });
        if (r.source === 'pdf') { extracted++; chars += r.chars; } else if (r.source === 'scanned') scanned++;
      } catch (e) {
        failed++;
        const msg = String((e && e.message) || e);
        if (errs.length < 10) errs.push({ doc: d.id, inv: number, error: msg });
        if (/EDIS_TOKEN|token rejected/.test(msg)) { console.error(`\nStopping: ${msg}. Refresh EDIS_TOKEN and re-run (extracted docs are skipped).`); throw e; }
      }
      await sleep(250);
    }
  } catch (e) {
    if (/EDIS_TOKEN|token rejected/.test(String((e && e.message) || e))) break;
    failed++;
    if (errs.length < 10) errs.push({ inv: number, error: String((e && e.message) || e) });
  }
  if (invDone % 10 === 0 || invDone === targets.length) {
    process.stdout.write(`\r  ${invDone}/${targets.length} inv · ${extracted} extracted (${(chars / 1048576).toFixed(1)} MB text), ${scanned} scanned, ${skipped} skipped, ${failed} failed…`);
  }
}
process.stdout.write('\n');
if (errs.length) console.log('Errors:', errs);
console.log(`Done: ${extracted} document(s) extracted (${(chars / 1048576).toFixed(1)} MB text), ${scanned} scanned (need OCR), ${skipped} already done, ${failed} failed.`);
console.log(extracted ? 'Next: node itc-outcome-fetch.mjs  (stage for the AI classify pass)' : '');
