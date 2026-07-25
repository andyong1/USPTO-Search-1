// Stage pre-order proceedings whose requester petition/decision attribution
// needs AI verification (preorder_ai_v behind) into a local work folder for the
// nightly Claude session. Companion to preorder-upload.mjs; instructions in
// preorder-verify.md.
//
// For each proceeding this stages the OPENING PAGES of every candidate document:
// petitions (RXPET* / PET.OP near the pre-order submission) and petition
// decisions (RXPTGR/RXPTDI after it). RXPET. is party-agnostic, so the AI reads
// who actually filed each paper and which petition each decision decides.
// Extracted text is cached in preorder_doc_text so version bumps re-read
// without re-downloading. PDFs come through the site's own /api/document proxy.
//
// Requires POSTGRES_URL in the environment (grounds-secrets.env). Run from the
// uspto-search folder:
//     node preorder-fetch.mjs             # default batch (25, newest first)
//     node preorder-fetch.mjs --limit 200 # full backfill
//
// Output: snq-cumulative/preorder-work/<app>__<docId>.txt  (one per candidate)
//         snq-cumulative/preorder-work/manifest.json

import { mkdir, writeFile, rm } from 'node:fs/promises';
import { sql } from '@vercel/postgres';
import pdfParse from 'pdf-parse/lib/pdf-parse.js';

if (!process.env.POSTGRES_URL) {
  console.error('POSTGRES_URL is not set. Load it from grounds-secrets.env first.');
  process.exit(1);
}

const args = process.argv.slice(2);
const limitIdx = args.indexOf('--limit');
const LIMIT = limitIdx >= 0 ? Number(args[limitIdx + 1]) : 25;

const SITE = 'https://andy-ong.com';
const DIR = 'snq-cumulative/preorder-work';
const NUL = new RegExp(String.fromCharCode(0), 'g');
const MAX_CHARS = 12000; // opening pages only — captions/openings decide attribution
const DAY = 86400000;
const parseISO = (s) => { const m = String(s || '').match(/(\d{4})-?(\d{2})-?(\d{2})/); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : NaN; };

await rm(DIR, { recursive: true, force: true }); // stale work must not be re-verified
await mkdir(DIR, { recursive: true });

const { rows } = await sql`
  SELECT * FROM (
    SELECT DISTINCT ON (application_number) application_number, official_date,
           petition_doc_id, petition_date, decision_doc_id, decision_date, decision_outcome
    FROM reexam_preorder
    WHERE (petition_doc_id IS NOT NULL OR decision_doc_id IS NOT NULL)
      AND coalesce(preorder_ai_v, 0) < 1
    ORDER BY application_number, official_date ASC NULLS LAST
  ) t ORDER BY t.official_date DESC NULLS LAST
  LIMIT ${LIMIT}`;

async function fetchJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

// Returns the candidate's text, or '' when the PDF has no text layer — in that
// case the PDF is saved to pdf/ for preorder-ocr.py (Windows built-in OCR, same
// engine as grounds-ocr.py) to fill the .txt in a follow-up step. Only real
// text is cached in preorder_doc_text; empty results are never cached.
async function candidateText(appNum, doc) {
  const { rows: hit } = await sql`SELECT txt FROM preorder_doc_text WHERE application_number = ${appNum} AND doc_id = ${doc.id} AND coalesce(txt, '') <> ''`;
  if (hit.length) return hit[0].txt;
  let txt = '';
  try {
    const r = await fetch(`${SITE}/api/document?appNum=${appNum}&documentId=${encodeURIComponent(doc.id)}&format=PDF&disposition=inline`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());
    const parsed = await pdfParse(buf, { max: 3 });
    txt = (parsed.text || '').replace(NUL, '').trim().slice(0, MAX_CHARS);
    if (txt.length < 80) { // image-only scan — hand off to the local OCR step
      txt = '';
      await mkdir(`${DIR}/pdf`, { recursive: true });
      await writeFile(`${DIR}/pdf/${appNum}__${doc.id}.pdf`, buf);
    }
  } catch (e) {
    console.error(`  ${appNum}/${doc.id}: ${e.message}`);
  }
  if (txt) {
    await sql`INSERT INTO preorder_doc_text (application_number, doc_id, doc_code, official_date, txt)
              VALUES (${appNum}, ${doc.id}, ${doc.code}, ${doc.date || null}, ${txt})
              ON CONFLICT (application_number, doc_id) DO UPDATE SET txt = EXCLUDED.txt`;
  }
  return txt;
}

const manifest = [];
for (const row of rows) {
  const app = row.application_number;
  const pd = parseISO(row.official_date);
  let bag = [];
  try { bag = (await fetchJson(`${SITE}/api/application?appNum=${app}&section=documents`)).documentBag || []; }
  catch (e) { console.error(`${app}: documents feed failed (${e.message}) — skipped`); continue; }

  const docs = bag.map((d) => ({
    id: d.documentIdentifier,
    code: (d.documentCode || '').toUpperCase(),
    date: (d.officialDate || '').slice(0, 10),
    desc: d.documentCodeDescriptionText || '',
  }));
  const petCands = docs.filter((d) => (/^RXPET/.test(d.code) || d.code === 'PET.OP')
    && !isNaN(pd) && !isNaN(parseISO(d.date)) && parseISO(d.date) >= pd - 20 * DAY && parseISO(d.date) <= pd + 45 * DAY);
  const decCands = docs.filter((d) => /^RXPT(GR|DI|D)/.test(d.code)
    && (isNaN(pd) || (!isNaN(parseISO(d.date)) && parseISO(d.date) >= pd)));
  const replyDates = docs.filter((d) => d.code === 'RX.PRO.RR').map((d) => d.date);
  const candidates = [...petCands, ...decCands];
  if (!candidates.length) { // nothing to read — leave for the heuristic as-is
    console.error(`${app}: no candidate documents found — skipped`);
    continue;
  }

  const entry = {
    application_number: app,
    preorder_date: row.official_date,
    flagged: { pet_doc_id: row.petition_doc_id, pet_date: row.petition_date, dec_doc_id: row.decision_doc_id, dec_date: row.decision_date, dec_outcome: row.decision_outcome },
    reply_dates: replyDates,
    candidates: [],
  };
  for (const c of candidates) {
    const txt = await candidateText(app, c);
    const file = `${app}__${c.id}.txt`;
    await writeFile(`${DIR}/${file}`, txt || '(no text extracted)', 'utf-8');
    entry.candidates.push({ doc_id: c.id, code: c.code, date: c.date, desc: c.desc, kind: /^RXPT(GR|DI|D)/.test(c.code) ? 'decision' : 'petition', file, chars: (txt || '').length });
  }
  manifest.push(entry);
  console.log(`${app}: staged ${entry.candidates.length} candidate doc(s)`);
}
await writeFile(`${DIR}/manifest.json`, JSON.stringify(manifest, null, 1), 'utf-8');

const { rows: cnt } = await sql`
  SELECT count(DISTINCT application_number)::int AS n FROM reexam_preorder
  WHERE (petition_doc_id IS NOT NULL OR decision_doc_id IS NOT NULL) AND coalesce(preorder_ai_v, 0) < 1`;
console.log(`${manifest.length} proceeding(s) staged in ${DIR} (${cnt[0].n} total awaiting AI verification).`);
console.log(manifest.length ? 'Next: verify per preorder-verify.md -> write preorder-out.jsonl -> node preorder-upload.mjs' : 'Nothing to verify.');
try { await sql.end(); } catch { /* already closed */ }
