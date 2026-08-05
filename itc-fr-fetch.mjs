// USITC Section 337 — Federal Register fetcher. Recovers party/patent data and
// outcomes for pre-EDIS / gap investigations that have no usable EDIS document,
// from the FREE federalregister.gov API (covers 1994+). Every 337 institution and
// Commission determination is published in the FR, naming the parties (incl.
// defaulters) and the outcome. Stages the FR notice text into the existing agent
// pipelines: --parties -> itc-work/parties-work (itc-parties.md schema), --outcomes
// -> itc-work/fr-outcome-work (itc-outcome.md schema). Then fan out extraction
// agents, combine, and upload with the normal itc-parties-upload / itc-outcome-upload.
//
// No EDIS token, no R2, no OCR — the FR text is born-digital. Requires POSTGRES_URL
// (+ NODE_OPTIONS=--use-system-ca).
//   node itc-fr-fetch.mjs --parties  [--limit N] [--inv 337-469]
//   node itc-fr-fetch.mjs --outcomes [--limit N] [--inv 337-469]

import { sql } from '@vercel/postgres';
import { writeFile, mkdir, rm } from 'fs/promises';

const args = process.argv.slice(2);
const MODE = args.includes('--outcomes') ? 'outcomes' : 'parties';
const LIMIT = args.includes('--limit') ? Number(args[args.indexOf('--limit') + 1]) : 100000;
const INV = args.includes('--inv') ? args[args.indexOf('--inv') + 1] : null;
const FR = 'https://www.federalregister.gov/api/v1/documents.json';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function retry(fn, tries = 4) {
  for (let i = 1; ; i++) { try { return await fn(); } catch (e) { if (i >= tries) throw e; await sleep(800 * i); } }
}
// All FR "Notice"-type documents mentioning this investigation, oldest first.
async function frNotices(ta) {
  const u = `${FR}?conditions%5Bterm%5D=%22${encodeURIComponent(ta)}%22&per_page=40&order=oldest`
    + '&fields%5B%5D=document_number&fields%5B%5D=title&fields%5B%5D=type&fields%5B%5D=publication_date&fields%5B%5D=raw_text_url';
  const j = await retry(() => fetch(u).then((r) => { if (!r.ok) throw new Error('FR HTTP ' + r.status); return r.json(); }));
  return (j.results || []).filter((d) => d.type === 'Notice');
}
// The FR raw_text_url is the GPO plain-text wrapped in minimal HTML (<pre> + <a>
// link tags + entities + [[Page N]] markers). Strip to clean text.
const stripHtml = (s) => String(s || '')
  .replace(/<a\s[^>]*>|<\/a>/gi, '')
  .replace(/<[^>]+>/g, '')
  .replace(/\[\[Page[^\]]*\]\]/g, '')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ')
  .replace(/[ \t]+\n/g, '\n');
const rawText = (url) => retry(() => fetch(url).then((r) => { if (!r.ok) throw new Error('raw HTTP ' + r.status); return r.text(); })).then(stripHtml);

// ── Targets ──────────────────────────────────────────────────────────────
let targets;
if (MODE === 'parties') {
  const { rows } = await sql`
    SELECT investigation_number n FROM itc_investigation
    WHERE public_number LIKE '337-TA-%' AND left(institution_date, 4) >= '1994'
      AND (${INV}::text IS NULL OR investigation_number = ${INV})
      AND investigation_number NOT IN (SELECT investigation_number FROM itc_parties WHERE complainants IS NOT NULL AND complainants::text <> '[]')
    ORDER BY institution_date DESC`;
  targets = rows.map((r) => r.n);
} else {
  const { rows } = await sql`
    SELECT i.investigation_number n FROM itc_investigation i
    LEFT JOIN itc_outcome o ON o.investigation_number = i.investigation_number
    WHERE i.public_number LIKE '337-TA-%' AND left(i.institution_date, 4) >= '1994'
      AND (${INV}::text IS NULL OR i.investigation_number = ${INV})
      AND o.ai_disposition IS NULL AND coalesce(i.outcome, 'unknown') = 'unknown'
    ORDER BY i.institution_date DESC`;
  targets = rows.map((r) => r.n);
}
targets = [...new Set(targets)].slice(0, LIMIT);   // dedupe: one number spans several phase rows

const DIR = MODE === 'parties' ? 'itc-work/parties-work' : 'itc-work/fr-outcome-work';
await rm(DIR, { recursive: true, force: true });
await mkdir(DIR, { recursive: true });
console.log(`Federal Register ${MODE}: ${targets.length} investigation(s) to fetch…`);

const isNoi = (t) => /notice of investigation|institution of (an )?investigation/i.test(t || '');
const isDisp = (t) => /final determination|determination.*(violation|terminat|no violation|review|rescind|consent)|termination of (the )?investigation|commission determination|issuance of/i.test(t || '');

// A FR 337 notice declares its subject investigation(s) in a bracketed docket header
// near the top, e.g. "[Investigation No. 337-TA-1128]" or "[Investigation Nos.
// 337-TA-1128 and 337-TA-1129]". A bare 337-TA-N elsewhere in the body — a
// "consolidate ... with Inv. No. ..." clause or a "see ..., Inv. No. ..." case
// citation — does NOT make the notice about that investigation. That is the guard:
// match on the declared subject, not on any mention.
const declaredInvs = (t) => {
  const set = new Set();
  const re = /\[\s*investigation\s+nos?\.?\s*([^\]]*?)\]/gi;
  let m;
  while ((m = re.exec(String(t || '')))) for (const n of m[1].match(/337-TA-\d+/gi) || []) set.add(n.toUpperCase());
  return set;
};
const declaresInv = (t, ta) => {
  const declared = declaredInvs(t);
  // With bracketed headers present, require THIS investigation to be one of them. Only
  // when a notice has no bracket header at all (rare cross-investigation notices, e.g. a
  // URAA term-extension list) fall back to the weaker "names it anywhere" test.
  return declared.size ? declared.has(ta.toUpperCase())
    : new RegExp(ta.replace(/[- ]/g, '[- ]?'), 'i').test(String(t || ''));
};

const manifest = [];
let ok = 0, none = 0, failed = 0; const errs = [];
for (const num of targets) {
  const ta = num.replace('337-', '337-TA-');
  try {
    const notices = await frNotices(ta);
    if (!notices.length) { none++; continue; }
    let staged = null;
    if (MODE === 'parties') {
      // Institution ("notice of investigation") notices first, oldest first, then any
      // other notice — stage the FIRST whose own docket header declares THIS
      // investigation. Drops wrong-doc hits (a neighbor's consolidation notice or a
      // case citation) AND, when the real notice is among the hits, picks it over one.
      const candidates = [...notices.filter((d) => isNoi(d.title)), ...notices.filter((d) => !isNoi(d.title))];
      for (const noi of candidates.slice(0, 6)) {
      const text = (await rawText(noi.raw_text_url)).replace(/ /g, ' ');
        if (text && text.length > 300 && declaresInv(text, ta)) {
          await writeFile(`${DIR}/${num}.txt`, `INVESTIGATION: ${num}\nNOI docId: FR-${noi.document_number}\n\n${text}\n`, 'utf-8');
          manifest.push({ investigation_number: num, noiDocId: `FR-${noi.document_number}`, chars: text.length });
          staged = true;
          break;
        }
        await sleep(120);
      }
    } else {
      // Concatenate the dispositive determination notices that actually declare THIS
      // investigation (newest first), capped — skipping ones that only mention it.
      const disp = notices.filter((d) => isDisp(d.title)).reverse();
      if (disp.length) {
        let body = ''; const used = [];
        for (const d of disp.slice(0, 6)) {
          const t = await rawText(d.raw_text_url);
          if (declaresInv(t, ta)) { body += `\n=== FR ${d.publication_date} · ${d.title} (FR-${d.document_number}) ===\n${t}\n`; used.push(d); if (used.length >= 4) break; }
          await sleep(150);
        }
        body = body.slice(0, 90000);
        if (body.length > 300) {
          await writeFile(`${DIR}/${num}.txt`, `INVESTIGATION: ${num}\n\n${body}\n`, 'utf-8');
          manifest.push({ investigation_number: num, docs: used.map((d) => ({ docId: `FR-${d.document_number}`, title: d.title, date: d.publication_date })), chars: body.length });
          staged = true;
        }
      }
    }
    if (staged) ok++; else none++;
  } catch (e) { failed++; if (errs.length < 10) errs.push({ inv: num, error: String((e && e.message) || e) }); }
  if ((ok + none + failed) % 10 === 0) process.stdout.write(`\r  ${ok + none + failed}/${targets.length} · ${ok} staged, ${none} no-notice, ${failed} failed…`);
  await sleep(200);
}
process.stdout.write('\n');
await writeFile(`${DIR}/manifest.json`, JSON.stringify(manifest, null, 1), 'utf-8');
if (errs.length) console.log('Errors:', errs);
console.log(`Staged ${ok} investigation(s) in ${DIR} (${none} had no usable FR notice, ${failed} failed).`);
console.log(MODE === 'parties'
  ? 'Next: fan out extraction agents over the staged NOIs (itc-parties.md schema) -> itc-parties-out.jsonl -> node itc-parties-upload.mjs'
  : 'Next: fan out classify agents (itc-outcome.md schema) -> itc-outcome-out.jsonl -> node itc-outcome-upload.mjs');
process.exit(0);
