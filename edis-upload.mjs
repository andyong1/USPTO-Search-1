// USITC Section 337 tracker — LOCAL uploader.
//
// Reads the crawl artifacts from itc-work/ (produced by edis-fetch.mjs), upserts
// them into Neon (the durable source of truth), computes the Phase-1 heuristic
// derivations per investigation, then PUBLISHES a small JSON projection to a
// public Vercel Blob that the static /itc page fetches directly.
//
// Why a Blob and not a serverless function: the site is at Vercel's Hobby
// 12-function limit, and the goal is ~zero active CPU. A Blob read is a
// CDN-served static file — no function, no cold start, no DB in the read path.
//
// Requires in the environment (load grounds-secrets.env first):
//   POSTGRES_URL            — Neon connection (source of truth)
//   BLOB_READ_WRITE_TOKEN   — Vercel Blob write token (publishes the projection)
//   NODE_EXTRA_CA_CERTS     — on a corporate/SSL-inspected network, a PEM bundle
//                             of trusted roots (incl. the interception CA) so
//                             Node's fetch can reach Neon/Blob over TLS.
//
//   node edis-upload.mjs                # ingest + derive + publish
//   node edis-upload.mjs --derive-only  # skip ingest; re-derive from DB + publish
//                                         (use when documents are already in Neon)
//   node edis-upload.mjs --publish-only # ONLY rebuild the main projection blob
//                                         (fast; use after new AI outcomes — no
//                                         re-derive, no per-investigation blobs)
//   node edis-upload.mjs --no-blob      # ingest + derive only (skip publish)

import { readFile, readdir } from 'node:fs/promises';
import { put } from '@vercel/blob';
import {
  upsertInvestigation, upsertDocuments, documentsForInvestigation,
  setInvestigationDerived, listInvestigations, logScan, numbersWithDocuments, listOutcomes,
} from './lib/itc-db.js';
import { loadCatalogMaps, publishInvestigationDocs } from './lib/itc-publish.js';

if (!process.env.POSTGRES_URL) {
  console.error('POSTGRES_URL is not set. Load it from grounds-secrets.env first.');
  process.exit(1);
}

const DIR = 'itc-work';
const DOC_DIR = `${DIR}/documents`;
const DERIVED_V = 1;          // bump to force re-derivation of every investigation
const BLOB_PATH = 'itc/itc-data.json';
const args = process.argv.slice(2);
const PUBLISH = !args.includes('--no-blob') && !!process.env.BLOB_READ_WRITE_TOKEN;

// Retry transient network failures (common through an SSL-inspection proxy that
// intermittently drops rapid TLS connections) instead of aborting the whole run.
async function retry(fn, tries = 5) {
  for (let i = 1; ; i++) {
    try { return await fn(); }
    catch (e) {
      const msg = String((e && e.message) || e);
      if (i >= tries || !/fetch failed|ECONN|ETIMEDOUT|EPIPE|socket|network|terminated/i.test(msg)) throw e;
      await new Promise((r) => setTimeout(r, 700 * i));
    }
  }
}

// ── Phase-1 heuristic outcome/remedy classifier (metadata only) ────────
// Section 337 outcomes are read from the TYPES/TITLES of terminal documents in
// EDIS — no PDF text. This is deliberately coarse and flags ambiguity for review;
// precise complainant/respondent roles and merits outcomes are a Phase-2 job
// (parsing the Notice of Investigation and Commission opinion). Order matters:
// a remedy implies a violation was found, so it is checked first.
function classifyOutcome(docs, status) {
  const hay = docs.map((d) => `${d.document_type || ''} :: ${d.document_title || ''}`.toLowerCase());
  const any = (re) => hay.some((h) => re.test(h));

  let remedy = null;
  if (any(/general exclusion order/)) remedy = 'GEO';
  else if (any(/limited exclusion order/)) remedy = 'LEO';
  else if (any(/exclusion order/)) remedy = 'LEO';          // unspecified → treat as limited
  const cdo = any(/cease and desist/);

  let outcome, reviewFlag = false;
  if (remedy || cdo) {
    outcome = 'violation_remedy';                            // violation found + remedy issued
    if (!remedy && cdo) remedy = 'CDO';
  } else if (any(/consent order/) || any(/settlement agreement/) || any(/motion to terminate.*(settl|license)/)) {
    outcome = 'terminated_settlement';
  } else if (any(/(finding|determination) of no violation/) || any(/no violation/)) {
    outcome = 'no_violation';
  } else if (any(/terminat/)) {
    outcome = 'terminated_other';                            // withdrawn, defaulted-then-terminated, etc.
  } else if (status === 'Active') {
    outcome = 'pending';
  } else {
    outcome = 'unknown';
    reviewFlag = true;                                       // inactive but no terminal signal — verify
  }
  return { outcome, remedy, reviewFlag };
}

// Institution date proxy: earliest "Notice of Investigation"/"Institution" doc,
// else the earliest received date on record (docs are oldest-first).
function institutionDate(docs) {
  const noi = docs.find((d) => /institution|notice of investigation/i.test(`${d.document_type} ${d.document_title}`));
  if (noi && noi.received_date) return noi.received_date;
  const first = docs.find((d) => d.received_date);
  return first ? first.received_date : null;
}

// The Commission and its staff are not "participants" worth listing; drop obvious
// Commission/staff filers from the party/firm rollups.
const isCommission = (s) => /usitc|office of the secretary|office of unfair import|international trade commission|commission investigative/i.test(s || '');

function deriveOne(docs, status) {
  const publicDocs = docs.filter((d) => (d.security_level || '').toLowerCase() === 'public');
  const { outcome, remedy, reviewFlag } = classifyOutcome(docs, status);

  const firmCounts = new Map();
  const parties = new Set();
  for (const d of docs) {
    if (d.firm_organization && !isCommission(d.firm_organization)) firmCounts.set(d.firm_organization, (firmCounts.get(d.firm_organization) || 0) + 1);
    if (d.on_behalf_of && !isCommission(d.on_behalf_of)) parties.add(d.on_behalf_of);
  }
  const topFirms = [...firmCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([firm, count]) => ({ firm, count }));
  const dates = docs.map((d) => d.received_date).filter(Boolean).sort();

  return {
    institutionDate: institutionDate(docs),
    lastDocDate: dates.length ? dates[dates.length - 1] : null,
    docCount: docs.length,
    publicDocCount: publicDocs.length,
    outcome, remedy, reviewFlag,
    participants: [...parties].slice(0, 40),
    topFirms,
  };
}

// Re-derive heuristics for the given investigation numbers from documents ALREADY
// in Neon. Each number is retried on transient errors and isolated in try/catch,
// so a blip on one investigation never aborts the run. A final pass re-attempts
// the ones that still failed (the SSL-inspection proxy drops different
// connections each time, so a second try clears almost all of them).
async function deriveNumbers(numbers) {
  const { phasesByNumber, statusByKey, metaByNumber } = await loadCatalogMaps(DIR);
  let derived = 0, published = 0;

  // Derive + publish one investigation; throws on failure so the caller isolates it.
  const processNumber = async (number) => {
    const n = await retry(async () => {
      const all = await documentsForInvestigation(number);
      const phases = phasesByNumber.get(number) || new Set(all.map((d) => d.investigation_phase));
      let c = 0;
      for (const phase of phases) {
        const docs = all.filter((d) => d.investigation_phase === phase);
        if (!docs.length) continue;
        const status = statusByKey.get(`${number} ${phase}`) || null;
        await setInvestigationDerived(number, phase, deriveOne(docs, status), DERIVED_V);
        c++;
      }
      return c;
    });
    derived += n;
    if (PUBLISH) { await retry(() => publishInvestigationDocs(number, metaByNumber.get(number))); published++; }
  };

  let failedNumbers = [];
  let i = 0;
  for (const number of numbers) {
    i++;
    try { await processNumber(number); }
    catch { failedNumbers.push(number); }
    if (i % 25 === 0 || i === numbers.length) process.stdout.write(`\r  derived ${i}/${numbers.length}, published ${published} detail blob(s)…`);
  }
  process.stdout.write('\n');

  // Final convergence pass over just the first-pass failures.
  if (failedNumbers.length) {
    console.log(`  retrying ${failedNumbers.length} investigation(s) that failed on the first pass…`);
    const stillFailed = [];
    for (const number of failedNumbers) {
      try { await processNumber(number); }
      catch (e) { stillFailed.push({ number, error: String((e && e.message) || e) }); }
    }
    failedNumbers = stillFailed;
    if (failedNumbers.length) console.log(`  ${failedNumbers.length} still failed after the retry pass:`, failedNumbers.slice(0, 10));
    else console.log('  retry pass cleared all failures.');
  }

  await retry(() => logScan('documents', numbers.length, null, `derived ${derived} phase-records; ${failedNumbers.length} failed`));
  console.log(`Derived heuristics for ${derived} (number, phase) record(s) across ${numbers.length} investigation(s).`);
  return derived;
}

// ── Ingest ─────────────────────────────────────────────────────────────
async function ingestInvestigations() {
  let list;
  try { list = JSON.parse(await readFile(`${DIR}/investigations.json`, 'utf-8')); }
  catch { console.log('No investigations.json — skipping catalog ingest.'); return 0; }
  for (const inv of list) await retry(() => upsertInvestigation(inv));
  await retry(() => logScan('investigations', list.length, null, 'catalog upsert'));
  console.log(`Upserted ${list.length} investigation records.`);
  return list.length;
}

async function ingestDocuments() {
  let files;
  try { files = (await readdir(DOC_DIR)).filter((f) => f.endsWith('.json')); }
  catch { console.log('No documents/ dir — skipping document ingest + derivation.'); return; }
  let totalDocs = 0;
  const touched = new Set();
  for (const f of files) {
    const docs = JSON.parse(await readFile(`${DOC_DIR}/${f}`, 'utf-8'));
    if (docs.length) { totalDocs += await retry(() => upsertDocuments(docs)); docs.forEach((d) => touched.add(d.number)); }
  }
  console.log(`Upserted ${totalDocs} documents across ${touched.size} investigation(s).`);
  await deriveNumbers([...touched]);
}

// ── Publish the page projection to Vercel Blob ─────────────────────────
async function publish() {
  // Exclude any malformed/administrative records that predate the crawl-side
  // filter, so the published projection is clean without a re-crawl.
  const rows = (await retry(() => listInvestigations())).filter((r) => /^337-\d+$/.test(r.investigation_number || ''));
  const outcomes = await retry(() => listOutcomes());
  const oMap = new Map(outcomes.map((o) => [o.investigation_number, o]));
  // The AI outcome is investigation-level; attach it ONLY to the primary phase —
  // the 'Violation' phase, else the earliest-instituted — so sub-proceeding rows
  // (Enforcement/Remand/Modification/etc.) keep their own per-phase heuristic
  // instead of all showing the same duplicated AI outcome.
  const primaryByNumber = new Map();
  for (const r of rows) {
    const cur = primaryByNumber.get(r.investigation_number);
    if (!cur) { primaryByNumber.set(r.investigation_number, r); continue; }
    if (cur.investigation_phase === 'Violation') continue;
    if (r.investigation_phase === 'Violation'
        || String(r.institution_date || '9999-99-99') < String(cur.institution_date || '9999-99-99')) {
      primaryByNumber.set(r.investigation_number, r);
    }
  }
  const summary = { total: rows.length, active: 0, violation_remedy: 0, no_violation: 0,
    terminated_settlement: 0, terminated_other: 0, pending: 0, unknown: 0, geo: 0, leo: 0, cdo: 0,
    ai_classified: oMap.size };
  for (const r of rows) {
    if (r.status === 'Active') summary.active++;
    if (r.outcome && summary[r.outcome] != null) summary[r.outcome]++;
    if (r.remedy === 'GEO') summary.geo++; else if (r.remedy === 'LEO') summary.leo++; else if (r.remedy === 'CDO') summary.cdo++;
    const o = oMap.get(r.investigation_number);
    if (o && primaryByNumber.get(r.investigation_number) === r) {
      r.ai_disposition = o.ai_disposition; r.ai_violation = o.ai_violation; r.ai_remedies = o.ai_remedies;
      r.ai_commission_action = o.ai_commission_action; r.ai_confidence = o.ai_confidence; r.ai_note = o.ai_note;
    }
  }
  const payload = { generatedAt: new Date().toISOString(), source: 'USITC EDIS', derivedV: DERIVED_V, summary, investigations: rows };
  const json = JSON.stringify(payload);

  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    console.error('BLOB_READ_WRITE_TOKEN not set — cannot publish. (Data is in Neon; add the token and re-run "node edis-upload.mjs --derive-only".)');
    process.exit(1);
  }
  const res = await retry(() => put(BLOB_PATH, json, {
    access: 'public',
    contentType: 'application/json',
    addRandomSuffix: false,     // stable URL so itc.html can hardcode it
    allowOverwrite: true,       // overwrite the same path each run
    cacheControlMaxAge: 300,    // 5-min edge cache so a new run propagates quickly
  }));
  console.log(`\nPublished projection (${rows.length} records, ${(json.length / 1024).toFixed(0)} KB) →\n  ${res.url}`);
  console.log('\n⇒ Put this URL in itc.html as ITC_DATA_URL (it is stable across runs).');
  return res.url;
}

// ── Entry ────────────────────────────────────────────────────────────
try {
  if (args.includes('--publish-only')) {
    console.log('Rebuilding the main projection only (no re-derive, no per-investigation blobs)…');
  } else if (args.includes('--derive-only')) {
    const numbers = await numbersWithDocuments();
    console.log(`Re-deriving from ${numbers.length} investigation(s) already in Neon…`);
    await deriveNumbers(numbers);
  } else {
    await ingestInvestigations();
    await ingestDocuments();
  }
  if (!args.includes('--no-blob')) await publish();
  console.log('\nDone.');
} catch (e) {
  console.error(`\nUpload failed: ${(e && e.message) || e}`);
  process.exit(1);
}
