// Stage post-order petition clusters whose attribution needs AI verification
// (rows shown on /reexam-petitions with post_ai_v behind) into a local work
// folder for the nightly Claude session. Companion to postpet-upload.mjs;
// instructions in postpet-verify.md.
//
// For each proceeding this stages the OPENING PAGES of every candidate paper:
// petition-type papers (PET.OP / RXPET. — party- and purpose-agnostic),
// requester oppositions (RXOPPPET), and petition decisions (RXPTGR/RXPTDI or
// description-matched). The AI reads who filed each paper, whether the PO
// petition actually cites § 325(d) seeking reconsideration/termination of the
// order, and which decision rules on THAT petition. Text is cached in
// preorder_doc_text (shared petition-cluster cache) so version bumps re-read
// without re-downloading. PDFs come through the site's own /api/document proxy.
//
// Requires POSTGRES_URL in the environment (grounds-secrets.env). Run from the
// uspto-search folder:
//     node postpet-fetch.mjs             # default batch (25, newest first)
//     node postpet-fetch.mjs --limit 200 # full backfill
//
// Output: snq-cumulative/postpet-work/<app>__<docId>.txt  (one per candidate)
//         snq-cumulative/postpet-work/pdf/                (image-only PDFs → preorder-ocr.py)
//         snq-cumulative/postpet-work/manifest.json

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
const DIR = 'snq-cumulative/postpet-work';
const NUL = new RegExp(String.fromCharCode(0), 'g');
const MAX_CHARS = 12000;
const PET_CAP = 6; // petition-type papers per proceeding (exhibits can be many)
const parseISO = (s) => { const m = String(s || '').match(/(\d{4})-?(\d{2})-?(\d{2})/); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : NaN; };

await rm(DIR, { recursive: true, force: true }); // stale work must not be re-verified
await mkdir(DIR, { recursive: true });

const { rows } = await sql`
  SELECT application_number, order_date, petition_doc_id, petition_date, petition_325d,
         opposition_doc_id, opposition_date, decision_doc_id, decision_date, decision_outcome, decision_325d
  FROM reexam_post_petitions
  WHERE order_date >= '2025-01-01'
    AND petition_325d IS DISTINCT FROM false
    AND decision_325d IS DISTINCT FROM false
    AND coalesce(post_ai_v, 0) < 1
  ORDER BY petition_date DESC NULLS LAST
  LIMIT ${LIMIT}`;

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
  const od = parseISO(row.order_date);
  let bag = [];
  try {
    const r = await fetch(`${SITE}/api/application?appNum=${app}&section=documents`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    bag = (await r.json()).documentBag || [];
  } catch (e) { console.error(`${app}: documents feed failed (${e.message}) — skipped`); continue; }

  const docs = bag.map((d) => ({
    id: d.documentIdentifier,
    code: (d.documentCode || '').toUpperCase(),
    date: (d.officialDate || '').slice(0, 10),
    desc: d.documentCodeDescriptionText || '',
    pages: d.pageCount ?? null,
  }));
  const onAfterOrder = (d) => { const t = parseISO(d.date); return !isNaN(t) && (isNaN(od) || t >= od); };
  const petPapers = docs.filter((d) => (d.code === 'PET.OP' || d.code === 'RXPET.') && onAfterOrder(d))
    .sort((a, b) => a.date.localeCompare(b.date)).slice(0, PET_CAP);
  const opps = docs.filter((d) => d.code === 'RXOPPPET' && onAfterOrder(d));
  const decs = docs.filter((d) => (d.code === 'RXPTGR' || d.code === 'RXPTDI'
      || (/petition/i.test(d.desc) && /(dismiss|grant|denied|decision)/i.test(d.desc))) && onAfterOrder(d))
    .filter((d) => !petPapers.includes(d) && !opps.includes(d));
  const candidates = [
    ...petPapers.map((d) => ({ ...d, kind: 'petition-paper' })),
    ...opps.map((d) => ({ ...d, kind: 'opposition' })),
    ...decs.map((d) => ({ ...d, kind: 'decision' })),
  ];
  if (!candidates.length) { console.error(`${app}: no candidate documents found — skipped`); continue; }

  const entry = {
    application_number: app,
    order_date: row.order_date,
    flagged: {
      pet_doc_id: row.petition_doc_id, pet_date: row.petition_date, pet_325d: row.petition_325d,
      opp_doc_id: row.opposition_doc_id, opp_date: row.opposition_date,
      dec_doc_id: row.decision_doc_id, dec_date: row.decision_date, dec_outcome: row.decision_outcome, dec_325d: row.decision_325d,
    },
    candidates: [],
  };
  for (const c of candidates) {
    const txt = await candidateText(app, c);
    const file = `${app}__${c.id}.txt`;
    await writeFile(`${DIR}/${file}`, txt || '(no text extracted)', 'utf-8');
    entry.candidates.push({ doc_id: c.id, code: c.code, date: c.date, desc: c.desc, pages: c.pages, kind: c.kind, file, chars: (txt || '').length });
  }
  manifest.push(entry);
  console.log(`${app}: staged ${entry.candidates.length} candidate doc(s)`);
}
await writeFile(`${DIR}/manifest.json`, JSON.stringify(manifest, null, 1), 'utf-8');

const { rows: cnt } = await sql`
  SELECT count(*)::int AS n FROM reexam_post_petitions
  WHERE order_date >= '2025-01-01' AND petition_325d IS DISTINCT FROM false
    AND decision_325d IS DISTINCT FROM false AND coalesce(post_ai_v, 0) < 1`;
console.log(`${manifest.length} proceeding(s) staged in ${DIR} (${cnt[0].n} total awaiting AI verification).`);
console.log(manifest.length ? 'Next: OCR any pdf/ leftovers (preorder-ocr.py postpet-work) -> verify per postpet-verify.md -> node postpet-upload.mjs' : 'Nothing to verify.');
try { await sql.end(); } catch { /* already closed */ }
