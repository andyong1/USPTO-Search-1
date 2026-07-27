// Related-litigation pass: stage each reexam's RXLITSR ("Reexam Litigation
// Search Conducted") document — the CRU's litigation search report — so the
// nightly session can read the related district-court cases from it. The report
// is image-only, so image PDFs are saved for preorder-ocr.py. Court-context
// snippets from the determination text (the ~90 chars around each docket number)
// are carried in the manifest so the extractor can attach a spelled-out court to
// a case that gave only a docket number. Companion to rxlit-upload.mjs; spec in
// rxlit-verify.md.
//
// Requires POSTGRES_URL. Run from the uspto-search folder:
//     node rxlit-fetch.mjs             # default batch (25)
//     node rxlit-fetch.mjs --limit 50  # a recent slice
//
// Output: snq-cumulative/rxlit-work/<app>__litsr.txt   (search-report text)
//         snq-cumulative/rxlit-work/pdf/                (image-only → preorder-ocr.py)
//         snq-cumulative/rxlit-work/manifest.json

import { mkdir, writeFile, rm } from 'node:fs/promises';
import { sql } from '@vercel/postgres';
import pdfParse from 'pdf-parse/lib/pdf-parse.js';
import { getReexamsNeedingLitigation, cacheRxLitsrText, markReexamNoLitsr, getReexamCourtHints, countReexamsNeedingLitigation } from './lib/db.js';

if (!process.env.POSTGRES_URL) {
  console.error('POSTGRES_URL is not set. Load it from grounds-secrets.env first.');
  process.exit(1);
}

const args = process.argv.slice(2);
const limitIdx = args.indexOf('--limit');
const LIMIT = limitIdx >= 0 ? Number(args[limitIdx + 1]) : 25;

const SITE = 'https://andy-ong.com';
const DIR = 'snq-cumulative/rxlit-work';
const NUL = new RegExp(String.fromCharCode(0), 'g');
const CHARS = 20000, PAGES = 12;
const parseISO = (s) => { const m = String(s || '').match(/(\d{4})-?(\d{2})-?(\d{2})/); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : NaN; };

await rm(DIR, { recursive: true, force: true });
await mkdir(DIR, { recursive: true });

const rows = await getReexamsNeedingLitigation(LIMIT);

// Pick the latest RXLITSR document. Returns {id, date} or null.
function pickLitsr(docs) {
  const litsr = docs
    .filter((d) => (d.code || '').toUpperCase() === 'RXLITSR')
    .filter((d) => !isNaN(parseISO(d.date)))
    .sort((a, b) => parseISO(a.date) - parseISO(b.date));
  return litsr.length ? litsr[litsr.length - 1] : (docs.find((d) => (d.code || '').toUpperCase() === 'RXLITSR') || null);
}

async function litsrText(appNum, doc, cached) {
  if (cached && cached.trim()) return cached.trim().slice(0, CHARS);
  let txt = '';
  try {
    const r = await fetch(`${SITE}/api/document?appNum=${appNum}&documentId=${encodeURIComponent(doc.id)}&format=PDF&disposition=inline`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());
    const parsed = await pdfParse(buf, { max: PAGES });
    txt = (parsed.text || '').replace(NUL, '').trim().slice(0, CHARS);
    if (txt.length < 120) { // image-only scan → hand to preorder-ocr.py (stem must match <app>__litsr.txt)
      txt = '';
      await mkdir(`${DIR}/pdf`, { recursive: true });
      await writeFile(`${DIR}/pdf/${appNum}__litsr.pdf`, buf);
    }
  } catch (e) { console.error(`  ${appNum}/${doc.id}: ${e.message}`); }
  if (txt) await cacheRxLitsrText(appNum, doc.id, doc.date, txt);
  return txt;
}

const manifest = [];
let staged = 0, noLitsr = 0;
for (const row of rows) {
  const app = row.application_number;
  let bag = [];
  try {
    const r = await fetch(`${SITE}/api/application?appNum=${app}&section=documents`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    bag = (await r.json()).documentBag || [];
  } catch (e) { console.error(`${app}: documents feed failed (${e.message}) — skipped`); continue; }

  const docs = bag.map((d) => ({ id: d.documentIdentifier, code: (d.documentCode || '').toUpperCase(), date: (d.officialDate || '').slice(0, 10) }));
  const litsr = pickLitsr(docs);
  if (!litsr) { await markReexamNoLitsr(app); noLitsr++; console.log(`${app}: no RXLITSR — marked`); continue; }

  // Reuse cached OCR only if it's for the same document.
  const cached = row.litsr_doc_id === litsr.id ? row.litsr_text : '';
  const txt = await litsrText(app, litsr, cached);
  await cacheRxLitsrText(app, litsr.id, litsr.date, txt || null); // record identity even when image-only
  await writeFile(`${DIR}/${app}__litsr.txt`, txt || '(no text extracted)', 'utf-8');
  const courtHints = await getReexamCourtHints(app);
  manifest.push({
    application_number: app,
    litsr_doc_id: litsr.id, litsr_date: litsr.date,
    court_hints: courtHints,
    litsr_file: `${app}__litsr.txt`, chars: (txt || '').length,
  });
  staged++;
  console.log(`${app}: RXLITSR ${litsr.date} — ${(txt || '').length}c${courtHints ? ' (+court hints)' : ''}`);
}

await writeFile(`${DIR}/manifest.json`, JSON.stringify(manifest, null, 2), 'utf-8');
const awaiting = await countReexamsNeedingLitigation();
console.log(`\nStaged ${staged} RXLITSR doc(s); ${noLitsr} had none. ${awaiting} reexam(s) still awaiting litigation extraction.`);
console.log(staged ? 'Next: OCR image-only PDFs, then follow rxlit-verify.md → rxlit-upload.mjs.' : 'Nothing to analyze.');
try { await sql.end(); } catch { /* already closed */ }
