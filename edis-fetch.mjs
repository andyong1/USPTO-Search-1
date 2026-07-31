// USITC Section 337 tracker — LOCAL crawler for the EDIS Data Web Service.
//
// Pulls Section 337 investigation + document METADATA from the public, anonymous
// EDIS REST API (https://edis.usitc.gov/data/, XML only) and writes JSON artifacts
// to itc-work/. Companion: edis-upload.mjs (upsert → Neon + publish Blob).
//
// EDIS gotchas this handles (verified against the live API 2026-07-27):
//   • Section 337 investigations have investigationType exactly "Sec 337".
//   • One investigation number spans MULTIPLE phases (Violation, Remand, …), each
//     a separate record with its own docket — so (number, phase) is the key.
//   • XML entities appear in titles/firms (&#39;, &amp;) — decoded here.
//   • Pagination is 1-based via ?pageNumber=, ~100 records/page.
//   • Confidential documents appear as METADATA only; contents are never fetched.
//
// Runs anonymously (no key). Be polite: modest delay + retries. Node 18+.
//   node edis-fetch.mjs investigations              # full 337 catalog → itc-work/investigations.json
//   node edis-fetch.mjs documents --active          # docs for the CHANGING set: Active + Preinstitution dockets (default)
//   node edis-fetch.mjs documents --all             # docs for EVERY investigation (heavy backfill)
//   node edis-fetch.mjs documents --inv 337-1000    # docs for one investigation
//   node edis-fetch.mjs documents --active --limit 20

import { mkdir, writeFile, readFile } from 'node:fs/promises';

const BASE = 'https://edis.usitc.gov/data';
const DIR = 'itc-work';
const DOC_DIR = `${DIR}/documents`;
const UA = 'andy-ong.com ITC-337 tracker (personal research; contact via andy-ong.com)';
const PAGE_SIZE = 100;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Tiny, tolerant XML reader for EDIS's flat record schema ────────────
const ENT = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" };
function decode(s) {
  if (s == null) return null;
  return s
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&(amp|lt|gt|quot|apos);/g, (m) => ENT[m]);
}
// Split the XML into <record>…</record> blocks and turn each into a flat map of
// leaf tag → text (last value wins; empty self-closing tags → null).
function parseRecords(xml, recordTag) {
  const out = [];
  const re = new RegExp(`<${recordTag}>([\\s\\S]*?)</${recordTag}>`, 'g');
  let m;
  while ((m = re.exec(xml)) !== null) {
    const body = m[1];
    const rec = {};
    const tre = /<([A-Za-z][\w]*)>([\s\S]*?)<\/\1>/g;
    let t;
    while ((t = tre.exec(body)) !== null) rec[t[1]] = decode(t[2].trim()) || null;
    out.push(rec);
  }
  return out;
}

// EDIS dates look like "2021/06/09 00:00:00" → "2021-06-09" (date only).
function ymd(s) {
  const m = String(s || '').match(/(\d{4})[/-](\d{2})[/-](\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}
// Public "337-TA-1000" number from an investigation title.
function publicNumber(title) {
  const m = String(title || '').match(/337-TA-\d+/i);
  return m ? m[0].toUpperCase() : null;
}
// The public identifier, and the SINGLE SOURCE OF TRUTH for docket-vs-investigation
// labeling (the display just trusts public_number). Pre-institution matters are
// EDIS DOCKET numbers, which the ITC calls "Dkt. No. <n>" — NOT 337-TA
// investigations (EDIS misleadingly puts "Inv. No. 337-TA-<docket>" in their
// titles). A record is a docket when ANY of these hold:
//   • status is Preinstitution (still-pending or withdrawn-before-institution);
//   • the title carries EDIS's "DN <n>" docket shorthand; or
//   • the numeric part is above the instituted 337-TA range (~1450 today, growing
//     ~40/yr) — observed dockets sit at 2000-3900, a wide clean gap. Bump
//     DOCKET_FLOOR if the instituted series ever approaches it.
// NOTE: do NOT key off docketNumber == number — EDIS also sets that on some
// INSTITUTED investigations (e.g. 337-TA-1125 has docketNumber 1125), so it
// false-positives real investigations as dockets.
const DOCKET_FLOOR = 2000;
function derivePublicNumber(r) {
  const x = String(r.investigationNumber || '').split('-')[1] || '';
  const nx = Number(x);
  const isDocket =
    r.investigationStatus === 'Preinstitution' ||
    /\bDN\b/i.test(String(r.investigationTitle || '')) ||
    (Number.isFinite(nx) && nx >= DOCKET_FLOOR);
  if (isDocket) return x ? `Dkt. No. ${x}` : null;
  return publicNumber(r.investigationTitle);
}

async function getXml(url, { tries = 4 } = {}) {
  for (let attempt = 1; attempt <= tries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 45000);
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/xml' }, signal: ctrl.signal });
      clearTimeout(timer);
      const body = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      // EDIS serves an HTML "Site under maintenance" page (Wed 5:30–8:30pm ET) with
      // a 200 — detect it so a maintenance window doesn't look like an empty result.
      if (/under maintenance/i.test(body) || !/^\s*<\?xml|^\s*<results/i.test(body)) {
        throw new Error('EDIS returned a non-XML/maintenance page');
      }
      return body;
    } catch (e) {
      clearTimeout(timer);
      if (attempt === tries) throw e;
      await sleep(1500 * attempt);
    }
  }
}

// Page through any list endpoint until a genuinely EMPTY page ends it. EDIS
// defaults to 20 records/page but honors pageSize=100, so we request 100 to cut
// requests ~5×. Termination is by empty page (NOT by "fewer than pageSize" — that
// wrongly stopped after page 1 when the effective page size differed) with a
// repeat-guard: if the API ever re-serves the same first record (e.g. it clamps
// pageNumber past the end), we stop instead of looping forever.
async function crawlPaged(path, recordTag, { label } = {}) {
  const all = [];
  let prevSig = null;
  for (let page = 1; ; page++) {
    const sep = path.includes('?') ? '&' : '?';
    const xml = await getXml(`${BASE}/${path}${sep}pageSize=${PAGE_SIZE}&pageNumber=${page}`);
    const recs = parseRecords(xml, recordTag);
    if (recs.length === 0) break;
    const sig = JSON.stringify(recs[0]);
    if (sig === prevSig) break;                 // API repeated a page — end of range
    prevSig = sig;
    all.push(...recs);
    process.stdout.write(`\r  ${label || path}: page ${page}, ${all.length} records`);
    await sleep(300);
  }
  process.stdout.write('\n');
  return all;
}

// ── Mode: investigations catalog ───────────────────────────────────────
async function crawlInvestigations() {
  const recs = await crawlPaged('investigation?investigationType=Sec%20337', 'investigation', { label: '337 investigations' });
  const invs = recs.map((r) => ({
    number: r.investigationNumber,
    phase: r.investigationPhase,
    status: r.investigationStatus,
    title: r.investigationTitle,
    type: r.investigationType,
    docket: r.docketNumber,
    publicNumber: derivePublicNumber(r),
    // Keep only real 337 dockets ("337-<digits>"); the Sec 337 feed also returns
    // malformed/administrative test records (e.g. "x337-3483x", "NR-004", "MISC-999").
  })).filter((i) => i.phase && /^337-\d+$/.test(i.number || ''));
  await mkdir(DIR, { recursive: true });
  await writeFile(`${DIR}/investigations.json`, JSON.stringify(invs, null, 1), 'utf-8');
  const active = invs.filter((i) => i.status === 'Active').length;
  console.log(`Saved ${invs.length} investigation records (${active} Active) → ${DIR}/investigations.json`);
}

// ── Mode: documents for a set of investigations ─────────────────────────
async function crawlDocuments(targets) {
  await mkdir(DOC_DIR, { recursive: true });
  let done = 0;
  for (const number of targets) {
    // Documents are keyed by investigation number and span every phase.
    const recs = await crawlPaged(`document?investigationNumber=${encodeURIComponent(number)}`, 'document', { label: number });
    const docs = recs.map((r) => ({
      id: r.id,
      number: r.investigationNumber || number,
      phase: r.investigationPhase,
      documentType: r.documentType,
      documentTitle: r.documentTitle,
      securityLevel: r.securityLevel,
      firmOrganization: r.firmOrganization,
      filedBy: r.filedBy,
      onBehalfOf: r.onBehalfOf,
      documentDate: ymd(r.documentDate),
      receivedDate: ymd(r.officialReceivedDate),
      attachmentListUri: r.attachmentListUri,
    })).filter((d) => d.id);
    await writeFile(`${DOC_DIR}/${number}.json`, JSON.stringify(docs, null, 1), 'utf-8');
    done++;
    console.log(`  [${done}/${targets.length}] ${number}: ${docs.length} documents`);
    await sleep(400);
  }
  console.log(`Saved documents for ${done} investigation(s) → ${DOC_DIR}/`);
}

async function resolveTargets(args) {
  const invIdx = args.indexOf('--inv');
  if (invIdx >= 0) return [args[invIdx + 1]];
  let list;
  try { list = JSON.parse(await readFile(`${DIR}/investigations.json`, 'utf-8')); }
  catch { console.error(`No ${DIR}/investigations.json — run "node edis-fetch.mjs investigations" first.`); process.exit(1); }
  const wantAll = args.includes('--all');
  // The default (--active) crawls the CHANGING set — investigations still Active
  // AND pre-institution dockets (new complaints accrue filings and get instituted).
  // Concluded/Inactive matters are frozen, so they're skipped unless --all.
  const seen = new Set();
  const nums = [];
  for (const i of list) {
    if (!wantAll && i.status !== 'Active' && i.status !== 'Preinstitution') continue;
    if (seen.has(i.number)) continue;
    seen.add(i.number); nums.push(i.number);
  }
  const limIdx = args.indexOf('--limit');
  return limIdx >= 0 ? nums.slice(0, Number(args[limIdx + 1])) : nums;
}

// ── Entry ────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const mode = args[0];
try {
  if (mode === 'investigations') {
    await crawlInvestigations();
  } else if (mode === 'documents') {
    const targets = await resolveTargets(args);
    if (!targets.length) { console.log('No target investigations (none Active/Preinstitution? try --all or --inv).'); }
    else { console.log(`Crawling documents for ${targets.length} investigation(s)…`); await crawlDocuments(targets); }
  } else {
    console.log('Usage:\n  node edis-fetch.mjs investigations\n  node edis-fetch.mjs documents [--active|--all|--inv 337-XXXX] [--limit N]');
    process.exit(1);
  }
} catch (e) {
  console.error(`\nEDIS crawl failed: ${e.message || e}`);
  process.exit(1);
}
