// ONE-OFF backfill (options A + B from the requester-coverage probe). Re-processes
// the "empty bucket" — third-party reexams with a request doc on file but still no
// requester_name — to squeeze out more names two ways:
//   A) re-OCR the FRONT 20 pages (the pipeline only OCR'd 8; the probe found names
//      at pp 15-16 that an 8-page read missed).
//   B) cross-reference disclosed litigation: the case caption party that is NOT the
//      patent owner is the likely requester.
// This script stages each request PDF for OCR and writes a manifest carrying the
// B context (patent_owner + litigation captions) alongside the OCR target, so the
// AI pass can apply both rules. Downloads DIRECT from USPTO (local key → zero
// Vercel transfer). Companion OCR: `cat preorder-ocr.py | python - reqid-rescan 20 30000`.
// Then AI pass → reqid-out.jsonl → `node reqid-upload.mjs --dir reqid-rescan`.
//
//     set -a && . ./grounds-secrets.env && set +a && node reqid-rescan-fetch.mjs [--limit N] [--offset M]

import { mkdir, writeFile, rm } from 'node:fs/promises';
import { sql } from '@vercel/postgres';
import { fetchDocuments, fetchDocumentBytes } from './lib/uspto.js';

if (!process.env.POSTGRES_URL) { console.error('POSTGRES_URL not set — source grounds-secrets.env.'); process.exit(1); }
if (!process.env.USPTO_API_KEY) { console.error('USPTO_API_KEY not set — DIRECT mode required.'); process.exit(1); }

const args = process.argv.slice(2);
const num = (flag, def) => { const i = args.indexOf(flag); return i >= 0 ? Number(args[i + 1]) : def; };
const LIMIT = num('--limit', 100000);
const OFFSET = num('--offset', 0);

const DIR = 'snq-cumulative/reqid-rescan';
const parseISO = (s) => { const m = String(s || '').match(/(\d{4})-?(\d{2})-?(\d{2})/); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : NaN; };
function pickRequest(docs) {
  const reqs = docs.filter((d) => /^RXOSUB\.R|^RXO_\d+\.R/i.test((d.code || '').toUpperCase())).filter((d) => !isNaN(parseISO(d.date))).sort((a, b) => parseISO(a.date) - parseISO(b.date));
  return reqs.length ? reqs[0] : (docs.find((d) => /^RXOSUB\.R|^RXO_\d+\.R/i.test((d.code || '').toUpperCase())) || null);
}

// Only mkdir on the first wave (offset 0) so later waves append to the same dir.
if (OFFSET === 0) { await rm(DIR, { recursive: true, force: true }); await mkdir(`${DIR}/pdf`, { recursive: true }); }
else { await mkdir(`${DIR}/pdf`, { recursive: true }); }

const { rows } = await sql`
  SELECT rq.application_number, rq.req_doc_id, tc.patent_owner, lit.cases
  FROM reexam_requester rq
  LEFT JOIN reexam_tech_center tc ON tc.application_number = rq.application_number
  LEFT JOIN reexam_litigation lit ON lit.application_number = rq.application_number
  WHERE rq.reqid_v >= 1 AND rq.requester_name IS NULL AND rq.req_doc_id IS NOT NULL
  ORDER BY rq.application_number
  LIMIT ${LIMIT} OFFSET ${OFFSET}`;
console.log(`Empty-bucket slice: ${rows.length} reexams (offset ${OFFSET}). Downloading request PDFs (DIRECT)…`);

// Append to a shared manifest across waves.
let manifest = [];
try { manifest = JSON.parse(await (await import('node:fs/promises')).readFile(`${DIR}/manifest.json`, 'utf-8')); } catch { /* first wave */ }

let ok = 0, fail = 0;
for (const row of rows) {
  const app = row.application_number;
  try {
    const bag = await fetchDocuments(app);
    const docs = bag.map((d) => ({ id: d.documentIdentifier, code: (d.documentCode || '').toUpperCase(), date: (d.officialDate || '').slice(0, 10) }));
    const req = pickRequest(docs);
    if (!req) { console.log(`${app}: no request doc now — skipped`); fail++; continue; }
    const bytes = await fetchDocumentBytes(app, req.id, 'PDF').catch(() => null);
    if (!bytes || !bytes.buffer) { console.log(`${app}: download failed`); fail++; continue; }
    await writeFile(`${DIR}/pdf/${app}__req.pdf`, bytes.buffer);
    const captions = Array.isArray(row.cases) ? row.cases.map((c) => c && c.caption).filter(Boolean) : [];
    manifest.push({
      application_number: app, req_doc_id: req.id, req_code: req.code, req_date: req.date,
      req_file: `${app}__req.txt`, patent_owner: row.patent_owner || null, litigation: captions,
    });
    ok++;
    if (ok % 25 === 0) console.log(`  …${ok} staged`);
  } catch (e) { console.log(`${app}: ${e.message}`); fail++; }
}

await writeFile(`${DIR}/manifest.json`, JSON.stringify(manifest, null, 2), 'utf-8');
console.log(`\nStaged ${ok} PDF(s) this wave; ${fail} failed. Manifest now ${manifest.length} entries.`);
console.log('Next: cat preorder-ocr.py | python - reqid-rescan 20 30000');
try { await sql.end(); } catch { /* */ }
