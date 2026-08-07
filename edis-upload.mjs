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
//   node edis-upload.mjs                  # ingest + derive + publish. Per-investigation
//                                           detail blobs are republished INCREMENTALLY:
//                                           only investigations whose documents or catalog
//                                           meta (status/title/docket) changed this run,
//                                           plus a full sweep every Sunday (UTC). The main
//                                           projection blob is always rebuilt in full.
//   node edis-upload.mjs --full-republish # force a full detail-blob republish this run
//                                           (also automatic on a PUBLISH_FMT_V bump)
//   node edis-upload.mjs --derive-only    # skip ingest; re-derive from DB + publish ALL
//                                           (use when documents are already in Neon)
//   node edis-upload.mjs --publish-only   # ONLY rebuild the main projection blob
//                                           (fast; use after new AI outcomes — no
//                                           re-derive, no per-investigation blobs)
//   node edis-upload.mjs --no-blob        # ingest + derive only (skip publish)

import { readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { put } from '@vercel/blob';
import {
  upsertInvestigation, upsertDocuments, documentsForInvestigation,
  setInvestigationDerived, listInvestigations, logScan, numbersWithDocuments, listOutcomes, listParties,
  listOutcomeDocLinks,
} from './lib/itc-db.js';
import { loadCatalogMaps, publishInvestigationDocs } from './lib/itc-publish.js';
import { dispositiveRole } from './lib/itc-outcome.js';

if (!process.env.POSTGRES_URL) {
  console.error('POSTGRES_URL is not set. Load it from grounds-secrets.env first.');
  process.exit(1);
}

const DIR = 'itc-work';
const DOC_DIR = `${DIR}/documents`;
const DERIVED_V = 1;          // bump to force re-derivation of every investigation
const BLOB_PATH = 'itc/itc-data.json';
// Detail-blob format/derivation version. Bump this whenever the per-investigation
// blob shape (publishInvestigationDocs) or deriveOne changes, so the next run does a
// FULL republish and every blob adopts the new format instead of waiting to change.
const PUBLISH_FMT_V = 1;
const STATE_FILE = `${DIR}/.publish-state.json`;   // per-run signatures for incremental republish (gitignored)
// How many investigations to derive+publish at once. Each is a Neon write + a Vercel
// Blob PUT (network-bound), so a pool is a large win over the old sequential loop.
const CONCURRENCY = Math.max(1, Number(process.env.ITC_PUBLISH_CONCURRENCY) || 10);
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

// Run `worker` over `items` with at most `limit` in flight at once. Preserves the
// per-item isolation of the old sequential loop (the worker swallows its own errors)
// while collapsing wall-clock from sum-of-PUTs to slowest-lane.
async function mapPool(items, limit, worker) {
  let next = 0;
  const lanes = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (let i = next++; i < items.length; i = next++) await worker(items[i], i);
  });
  await Promise.all(lanes);
}

const sha1 = (s) => createHash('sha1').update(String(s)).digest('hex');
// Signature of the catalog-derived fields the detail blob embeds (title, public
// number, and per-phase status/docket). A change here means the blob is stale even
// with no new documents. Phases are sorted so the hash is order-independent.
const hashInvMeta = (m) => sha1(JSON.stringify({
  p: (m && m.publicNumber) || null,
  t: (m && m.title) || null,
  ph: (m && m.phases ? [...m.phases] : []).map((x) => [x.phase, x.status, x.docket])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
}));

async function loadPublishState() {
  try {
    const s = JSON.parse(await readFile(STATE_FILE, 'utf-8'));
    return { fmtV: s.fmtV, invHash: s.invHash || {}, docHash: s.docHash || {} };
  } catch { return null; }   // missing/corrupt → treat as first run (forces a full republish)
}
async function savePublishState(state) {
  try { await writeFile(STATE_FILE, JSON.stringify(state)); }
  catch (e) { console.log(`  (could not save publish state: ${(e && e.message) || e})`); }
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
    outcome = 'violation_remedy';                            // a final remedy order = violation found (may still show Active during Presidential review)
    if (!remedy && cdo) remedy = 'CDO';
  } else if (status === 'Active') {
    // An Active investigation is ongoing by definition: a partial termination or
    // settlement of an INDIVIDUAL respondent (common in multi-respondent cases)
    // does NOT conclude it, so never infer a terminal outcome from doc titles here.
    outcome = 'pending';
  } else if (any(/consent order/) || any(/settlement agreement/) || any(/motion to terminate.*(settl|license)/)) {
    outcome = 'terminated_settlement';
  } else if (any(/(finding|determination) of no violation/) || any(/no violation/)) {
    outcome = 'no_violation';
  } else if (any(/terminat/)) {
    outcome = 'terminated_other';                            // withdrawn, defaulted-then-terminated, etc.
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

  // Presiding ALJ from an "Assignment of ALJ <name>" document title (partial
  // coverage — ~1/3 of assignment notices don't name the judge). Take the most
  // recent name-bearing assignment (handles reassignments).
  let alj = null;
  const assigns = docs.filter((d) => /assignment/i.test(d.document_title || ''))
    .sort((a, b) => String(b.received_date || '').localeCompare(String(a.received_date || '')));
  for (const d of assigns) {
    const m = String(d.document_title || '').match(/(?:re)?assignment (?:of|to)\s+(?:the presiding\s+)?(?:(?:acting\s+)?chief\s+)?(?:a?c?alj|administrative law judge)\s+([A-Z][A-Za-z.'-]+(?:\s+[A-Z][A-Za-z.'-]+){0,2})/i);
    if (m) { alj = m[1].trim().replace(/\s+/g, ' '); break; }
  }
  // Decision date = latest dispositive-document date (final-determination proxy for pendency).
  const decDates = docs.filter((d) => dispositiveRole(d.document_type, d.document_title)).map((d) => d.received_date).filter(Boolean).sort();

  return {
    institutionDate: institutionDate(docs),
    lastDocDate: dates.length ? dates[dates.length - 1] : null,
    decisionDate: decDates.length ? decDates[decDates.length - 1] : null,
    alj,
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
  let derived = 0, published = 0, done = 0;

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

  // First pass — CONCURRENCY investigations in flight; failures are collected, not fatal.
  const failedNumbers = [];
  await mapPool(numbers, CONCURRENCY, async (number) => {
    try { await processNumber(number); }
    catch { failedNumbers.push(number); }
    finally {
      done++;
      if (done % 25 === 0 || done === numbers.length) process.stdout.write(`\r  derived ${done}/${numbers.length} (${CONCURRENCY}-way), published ${published} detail blob(s)…`);
    }
  });
  process.stdout.write('\n');

  // Final convergence pass over just the first-pass failures (gentler concurrency,
  // since these are the connections the proxy already dropped once).
  const stillFailed = [];
  if (failedNumbers.length) {
    console.log(`  retrying ${failedNumbers.length} investigation(s) that failed on the first pass…`);
    await mapPool(failedNumbers, Math.min(CONCURRENCY, 4), async (number) => {
      try { await processNumber(number); }
      catch (e) { stillFailed.push({ number, error: String((e && e.message) || e) }); }
    });
    if (stillFailed.length) console.log(`  ${stillFailed.length} still failed after the retry pass:`, stillFailed.slice(0, 10));
    else console.log('  retry pass cleared all failures.');
  }

  await retry(() => logScan('documents', numbers.length, null, `derived ${derived} phase-records; ${stillFailed.length} failed`));
  console.log(`Derived heuristics for ${derived} (number, phase) record(s) across ${numbers.length} investigation(s).`);
  return stillFailed.map((s) => s.number);   // still-failed numbers, so the caller can re-trigger them next run
}

// ── Ingest ─────────────────────────────────────────────────────────────
async function ingestInvestigations() {
  let list;
  try { list = JSON.parse(await readFile(`${DIR}/investigations.json`, 'utf-8')); }
  catch { console.log('No investigations.json — skipping catalog ingest.'); return 0; }
  await mapPool(list, CONCURRENCY, (inv) => retry(() => upsertInvestigation(inv)));   // distinct (number,phase) rows — safe to upsert concurrently
  await retry(() => logScan('investigations', list.length, null, 'catalog upsert'));
  console.log(`Upserted ${list.length} investigation records.`);
  return list.length;
}

async function ingestDocuments() {
  let files;
  try { files = (await readdir(DOC_DIR)).filter((f) => f.endsWith('.json')); }
  catch { console.log('No documents/ dir — skipping document ingest + derivation.'); return; }

  const prev = await loadPublishState();
  // A FULL republish (every investigation on disk) happens on: an explicit flag, the
  // first run / missing state, a format-version bump, or the weekly (Sunday UTC)
  // sweep — the safety net that heals anything an incremental diff could miss.
  const fullReason = args.includes('--full-republish') ? 'flag'
    : !prev ? 'no prior state'
    : prev.fmtV !== PUBLISH_FMT_V ? 'format bump'
    : new Date().getUTCDay() === 0 ? 'weekly sweep'
    : null;
  const full = fullReason !== null;

  // Walk every document file, but only UPSERT the ones whose content changed since
  // last run (a content hash per file) — unchanged files are already in Neon, and
  // re-upserting all ~400k docs nightly was the bulk of the runtime. A full run
  // re-ingests everything to re-establish DB authority (and heal any drift).
  let totalDocs = 0, upsertedFiles = 0;
  const allNumbers = new Set();
  const changed = new Set();
  const curDocHash = {};
  for (const f of files) {
    const raw = await readFile(`${DOC_DIR}/${f}`, 'utf-8');
    const docs = JSON.parse(raw);
    if (!docs.length) continue;
    const h = sha1(raw);
    curDocHash[f] = h;
    const nums = docs.map((d) => d.number);
    nums.forEach((n) => allNumbers.add(n));
    const fileChanged = !prev || prev.docHash[f] !== h;
    if (full || fileChanged) { totalDocs += await retry(() => upsertDocuments(docs)); upsertedFiles++; }
    if (fileChanged) nums.forEach((n) => changed.add(n));
  }
  console.log(`Upserted ${totalDocs} documents from ${upsertedFiles} changed file(s) (of ${files.length}); ${allNumbers.size} investigation(s) on disk.`);

  // Catalog-driven change: a title/status/docket/publicNumber shift (from the 17a
  // catalog crawl) changes the detail blob without any new document, so diff the
  // crawl meta too and fold those into the republish set.
  const { metaByNumber } = await loadCatalogMaps(DIR);
  const curInvHash = {};
  for (const [number, meta] of metaByNumber) {
    const hh = hashInvMeta(meta);
    curInvHash[number] = hh;
    if (!full && (!prev || prev.invHash[number] !== hh)) changed.add(number);
  }

  const publishSet = full ? [...allNumbers] : [...changed].filter((n) => allNumbers.has(n));
  console.log(full
    ? `Full republish (${fullReason}): ${publishSet.length} investigation(s).`
    : `Incremental republish: ${publishSet.length} of ${allNumbers.size} investigation(s) changed (documents and/or catalog).`);

  const failed = await deriveNumbers(publishSet);

  // Persist the new signatures so the next run can diff. Record current hashes for
  // everything, but poison the still-failed numbers' invHash so they re-publish next
  // run even if their inputs don't move again.
  const newInvHash = { ...(prev ? prev.invHash : {}), ...curInvHash };
  for (const n of failed) newInvHash[n] = '__retry__';
  await savePublishState({ fmtV: PUBLISH_FMT_V, invHash: newInvHash, docHash: { ...(prev ? prev.docHash : {}), ...curDocHash } });
}

// ── Publish the page projection to Vercel Blob ─────────────────────────
async function publish() {
  // Exclude any malformed/administrative records that predate the crawl-side
  // filter, so the published projection is clean without a re-crawl.
  const rows = (await retry(() => listInvestigations())).filter((r) => /^337-\d+$/.test(r.investigation_number || ''));
  const outcomes = await retry(() => listOutcomes());
  const oMap = new Map(outcomes.map((o) => [o.investigation_number, o]));
  const parties = await retry(() => listParties());
  const pMap = new Map(parties.map((p) => [p.investigation_number, p]));
  const outcomeDocLinks = await retry(() => listOutcomeDocLinks());
  const olMap = new Map(outcomeDocLinks.map((o) => [o.investigation_number, o]));
  // The AI outcome is investigation-level; attach it to EVERY phase row so
  // sub-proceeding rows (Modification/Rescission/Remand/Enforcement/etc.) show
  // the investigation's disposition instead of a bare "unknown" dash. Parties are
  // still overlaid onto the primary phase only (the 'Violation' phase, else the
  // earliest-instituted) to avoid duplicating them across every phase row.
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
  // The presiding ALJ is derived per phase-row (the assignment notice lives in one
  // phase), so sub-proceeding rows carry a null alj. Propagate the investigation's
  // ALJ to EVERY phase row so per-investigation stats (which pick one row) don't
  // miss it.
  const aljByNumber = new Map();
  for (const r of rows) { if (r.alj && !aljByNumber.has(r.investigation_number)) aljByNumber.set(r.investigation_number, r.alj); }
  const summary = { total: rows.length, active: 0, violation_remedy: 0, no_violation: 0,
    terminated_settlement: 0, terminated_other: 0, pending: 0, unknown: 0, geo: 0, leo: 0, cdo: 0,
    ai_classified: oMap.size };
  for (const r of rows) {
    if (r.status === 'Active') summary.active++;
    if (r.outcome && summary[r.outcome] != null) summary[r.outcome]++;
    if (r.remedy === 'GEO') summary.geo++; else if (r.remedy === 'LEO') summary.leo++; else if (r.remedy === 'CDO') summary.cdo++;
    if (!r.alj && aljByNumber.has(r.investigation_number)) r.alj = aljByNumber.get(r.investigation_number);
    const o = oMap.get(r.investigation_number);
    if (o) {
      r.ai_disposition = o.ai_disposition; r.ai_violation = o.ai_violation; r.ai_remedies = o.ai_remedies;
      r.ai_commission_action = o.ai_commission_action; r.ai_confidence = o.ai_confidence; r.ai_note = o.ai_note;
    }
    const ol = olMap.get(r.investigation_number);
    if (ol) {
      if (ol.excl_url || ol.cdo_url) {
        r.order_links = {};
        if (ol.excl_url) r.order_links.excl = ol.excl_url;   // GEO / LEO chips
        if (ol.cdo_url) r.order_links.cdo = ol.cdo_url;       // CDO chip
      }
      if (ol.opinion_url) r.opinion_url = ol.opinion_url;    // outcome badge → Commission opinion
    }
    if (primaryByNumber.get(r.investigation_number) === r) {
      const p = pMap.get(r.investigation_number);
      if (p) {
        r.complainants = p.complainants; r.respondents = p.respondents;
        r.asserted_patents = p.asserted_patents; r.accused_products = p.accused_products;
      }
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
