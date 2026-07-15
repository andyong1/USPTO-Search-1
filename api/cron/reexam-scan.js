// Reexamination determinations watcher (ex parte, 90/ series).
// Triggered by cron-job.org (hourly) with Authorization: Bearer <CRON_SECRET>.
//
// Each run:
//   1. Once/day: enumerate ex parte reexams filed in the last 6 months into
//      reexam_watch (and prune ones older than ~9 months).
//   2. Scan the next chunk of not-yet-determined reexams for RXREXO (reexam
//      ordered) / RXREXD (reexam denied) documents; record any new ones.
//   3. Once/day (8 AM PT): email subscribers a comprehensive digest of the prior
//      day's relevant filings (determinations, office actions, certificates, petitions).
//
// Work is chunked across hourly runs (rolling, least-recently-scanned first) so
// each invocation stays small enough for Vercel Hobby limits.

import {
  reexamState, setReexamEnumerated,
  upsertReexams, pruneReexams, getReexamScanBatch, markReexamScanned,
  recordDetermination,
  reexamCounts, getAppsMissingDeterminationMeta, updateDeterminationMeta,
  setRequesterType, getAppsMissingRequesterType, resetRequesterTypes, setRequesterLogicVersion,
  recordPreorder, updatePreorderPetition, PREORDER_CUTOFF,
  getPreorderCounts, setPreorderCounts,
  listReexamSubscribers, getSubDigestDate, setSubDigestDate,
  getDocEventsByOfficialDate,
  getDeterminationsToCheckConclusion, recordConclusionDocs,
  getDeterminationsToCheckTechCenter,
  getPatentsToScanForProceedings, markPatentProceedingsScanned, upsertPatentProceeding,
  upsertPtabInstitution, upsertPtabDd, getPtabKv, setPtabKv,
  getOrderedReexamsToCheckPetitions,
  getDecisionsToStartOcr, setDecisionOcrDone, setDecisionOcrFailed,
  getPetitionsToCheck325d, setPetition325dDone, setPetition325dPendingOcr, setPetition325dFailed,
  getActivePetitionsToRefresh,
  getOrderedReexamsToCheckActions,
} from '../../lib/db.js';
import { searchApplications, fetchDocuments, fetchMetaData, analyzePetition, fetchPreorderCoverage, classifyRequester, fetchTransactions } from '../../lib/uspto.js';
import { sendComprehensiveDigestTo } from '../../lib/email.js';
// Metadata-only helpers — import from the light module so this cron's bundle
// doesn't pull in pdf-lib / pdf-parse / OCR (which live in lib/ptab.js).
import { fetchFwdPage, fetchInstitutionPage, fetchDdPage, fetchProceedingsByPatent } from '../../lib/ptab-fetch.js';
import { detectPostOrderPetitionForApp, detectPetition325d } from '../../lib/petitions.js';
import { detectTechCenterForApp } from '../../lib/techcenter.js';
import { ocrConfigured, ocrDecision } from '../../lib/ocr.js';
import { detectActionsForApp } from '../../lib/actions.js';

export const config = { maxDuration: 60 };

const SCAN_BATCH = 25;        // reexams scanned per run
const CONCURRENCY = 5;
const WINDOW_MONTHS = 6;      // enumerate reexams filed within this window
const PRUNE_MONTHS = 24;      // drop reexams older than this (wide enough to keep
                             // the Jan 2025+ determination set in the watch table)
const DET_CODES = { RXREXO: 'Reexam Ordered', RXREXD: 'Reexam Denied' };
const PREORDER_CODE = 'RX.PRO.PO'; // patent owner pre-order SNQ submission
const REQUESTER_LOGIC_V = 4; // bump to force a one-time requester-type reclassification

const isoMonthsAgo = (m) => { const d = new Date(); d.setMonth(d.getMonth() - m); return d.toISOString().slice(0, 10); };
const hoursSince = (ts) => (ts ? (Date.now() - new Date(ts).getTime()) / 3.6e6 : Infinity);

// ── Daily subscriber email helpers (8:00 AM Pacific) ──
const SUB_TZ = 'America/Los_Angeles';
const SUB_SEND_HOUR = 8; // only the scan run during this PT hour sends the digest
const ymdInTZ = (d, tz) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
const hourInTZ = (d, tz) => Number(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', hour12: false }).format(d));
function previousDay(ymd) { const [y, m, d] = String(ymd).split('-').map(Number); const a = new Date(Date.UTC(y, m - 1, d)); a.setUTCDate(a.getUTCDate() - 1); return a.toISOString().slice(0, 10); }
function prettyDate(ymd) { const [y, m, d] = String(ymd).split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { timeZone: 'UTC', year: 'numeric', month: 'long', day: 'numeric' }); }
function baseUrl(req) {
  if (process.env.APP_BASE_URL) return process.env.APP_BASE_URL.replace(/\/$/, '');
  const host = process.env.VERCEL_PROJECT_PRODUCTION_URL || (req && req.headers && req.headers.host);
  return host ? `https://${host}` : '';
}

// Send the once-daily subscriber digest — every relevant document (determinations,
// office actions, certificates, petitions) whose USPTO date was the previous PT
// day — to all subscribers, each with a personal one-click unsubscribe link. Only
// the scan run in the 8 AM PT hour sends (so the hourly scan doesn't email every
// run); skips entirely when nothing issued. ?forceSubEmail=1 bypasses the gate.
async function maybeSendSubscriberDigest(req) {
  const force = req.query && req.query.forceSubEmail === '1';
  const now = new Date();
  const todayPT = ymdInTZ(now, SUB_TZ);
  const targetDate = (req.query && req.query.date) ? String(req.query.date) : previousDay(todayPT);

  if (!force) {
    if (hourInTZ(now, SUB_TZ) !== SUB_SEND_HOUR) return { skipped: 'not the 8 AM PT hour' };
    const lastSent = await getSubDigestDate();
    if (lastSent === targetDate) return { skipped: 'already handled today' };
  }

  const events = await getDocEventsByOfficialDate(targetDate);

  // PTAB final written decisions issued that same day (best-effort — a failure
  // here must not block the reexam digest). Dedupe to one row per trial.
  let ptabDecisions = [];
  try {
    const page = await fetchFwdPage({ types: ['IPR', 'PGR', 'CBM'], from: targetDate, to: targetDate, offset: 0, limit: 100 });
    const seen = new Set();
    for (const r of page.rows) {
      if (seen.has(r.trial_number)) continue;
      seen.add(r.trial_number);
      ptabDecisions.push({ trial: r.trial_number, type: r.trial_type, patent: r.patent_number, po: r.po_name, petitioner: r.petitioner_name, pdfUrl: r.fwd_pdf_url });
    }
  } catch (e) { ptabDecisions = []; }

  // PTAB Director-discretionary + Board institution decisions issued that same day
  // (best-effort; deduped per trial+kind). Shown before the FWD section.
  let ptabDecisionEvents = [];
  try {
    const seen = new Set();
    const push = (rows, kind, typeKey) => {
      for (const r of rows) {
        const k = kind + ':' + r.trial_number; if (seen.has(k)) continue; seen.add(k);
        ptabDecisionEvents.push({ trial: r.trial_number, type: r.trial_type, patent: r.patent_number, po: r.po_name, kind, decision: r[typeKey], pdfUrl: kind === 'Discretionary' ? r.dd_pdf_url : r.inst_pdf_url });
      }
    };
    const [inst, dd] = await Promise.all([
      fetchInstitutionPage({ from: targetDate, to: targetDate, offset: 0, limit: 100 }),
      fetchDdPage({ from: targetDate, to: targetDate, offset: 0, limit: 100 }),
    ]);
    // Persist what the digest surfaces so the /ptab-decisions table matches the
    // email — the digest fetch was otherwise display-only, so decisions issued
    // outside the daily maintain window could show in the email but never store.
    for (const r of dd.rows) { try { await upsertPtabDd(r); } catch { /* skip bad row */ } }
    for (const r of inst.rows) { try { await upsertPtabInstitution(r); } catch { /* skip bad row */ } }
    push(dd.rows, 'Discretionary', 'dd_type');
    push(inst.rows, 'Institution', 'inst_type');
  } catch (e) { ptabDecisionEvents = []; }

  // Mark the day handled even when empty, so we check at most once per day.
  if (!force) await setSubDigestDate(targetDate);

  if (!events.length && !ptabDecisions.length && !ptabDecisionEvents.length) return { date: targetDate, newDocs: 0, ptab: 0, ptabDecisions: 0, sent: 0 };

  const subscribers = await listReexamSubscribers();
  const base = baseUrl(req);
  const dateLabel = prettyDate(targetDate);
  let sent = 0; const errors = [];
  for (const s of subscribers) {
    const r = await sendComprehensiveDigestTo(s.email, events, {
      dateLabel, unsubscribeUrl: `${base}/api/reexam-subscribe?token=${encodeURIComponent(s.token)}`, ptabDecisions, ptabDecisionEvents,
    });
    if (r && r.sent) sent++;
    else if (r && (r.error || r.skipped)) errors.push({ email: s.email, reason: r.error || r.reason });
  }
  return { date: targetDate, newDocs: events.length, ptab: ptabDecisions.length, ptabDecisions: ptabDecisionEvents.length, subscribers: subscribers.length, sent, errors };
}

// Detect NIRC / reexamination certificate documents for ordered reexams, so we
// can flag concluded proceedings. Capped per run; rolling (re-checks weekly).
async function detectConclusionsStep(maxApps, deadline) {
  const rows = await getDeterminationsToCheckConclusion(maxApps);
  let found = 0;
  const errors = [];
  for (const r of rows) {
    if (Date.now() > deadline) break;
    const app = r.application_number;
    try {
      const docs = await fetchDocuments(app);
      let nirc = null; const certs = [];
      for (const d of docs) {
        const code = (d.documentCode || '').toUpperCase();
        if (code === 'RXNIRC' && !nirc) nirc = d;
        if (code === 'RXCERT') certs.push({ id: d.documentIdentifier, date: d.officialDate });
      }
      await recordConclusionDocs(app, {
        nircDocId: nirc && nirc.documentIdentifier, nircDate: nirc && nirc.officialDate,
        certCandidates: certs,
      });
      if (nirc || certs.length) found++;
    } catch (e) { errors.push({ application: app, error: String(e.message || e) }); }
  }
  return { checked: rows.length, concluded: found, errors };
}

async function enumerate() {
  const from = isoMonthsAgo(WINDOW_MONTHS);
  let offset = 0;
  let added = 0;
  for (let page = 0; page < 40; page++) { // hard cap (40 * 100 = 4000)
    const data = await searchApplications({
      q: 'applicationNumberText:90*',
      rangeFilters: [{ field: 'applicationMetaData.filingDate', valueFrom: from, valueTo: '2100-01-01' }],
      fields: ['applicationNumberText', 'applicationMetaData.filingDate'],
      pagination: { offset, limit: 100 },
    });
    const hits = data.patentFileWrapperDataBag || [];
    if (!hits.length) break;
    const items = hits.map((h) => ({
      applicationNumber: h.applicationNumberText || (h.applicationMetaData && h.applicationMetaData.applicationNumberText),
      filingDate: h.applicationMetaData && h.applicationMetaData.filingDate,
    })).filter((x) => x.applicationNumber);
    await upsertReexams(items);
    added += items.length;
    offset += 100;
    if (hits.length < 100) break;
  }
  await pruneReexams(isoMonthsAgo(PRUNE_MONTHS));
  await setReexamEnumerated();
  return added;
}

async function scanOne(appNum, filingDate) {
  const docs = await fetchDocuments(appNum);

  // Patent owner pre-order SNQ submissions (for reexams filed on/after cutoff),
  // plus any requestor petition within 20 days and its decision.
  if (filingDate && filingDate >= PREORDER_CUTOFF) {
    const preDocs = docs.filter((x) => (x.documentCode || '').toUpperCase() === PREORDER_CODE);
    for (const d of preDocs) {
      await recordPreorder({ applicationNumber: appNum, documentIdentifier: d.documentIdentifier, officialDate: d.officialDate, filingDate });
    }
    if (preDocs.length) {
      const { petition, decision } = analyzePetition(docs, preDocs[0].officialDate);
      await updatePreorderPetition(appNum, petition, decision);
    }
  }

  const detDocs = docs.filter((d) => DET_CODES[d.documentCode]);
  if (!detDocs.length) {
    await markReexamScanned(appNum, false);
    return 0;
  }

  // A determination exists — fetch metadata once for group art unit + examiner.
  const meta = await fetchMetaData(appNum).catch(() => ({}));

  let found = 0;
  for (const d of detDocs) {
    const isNew = await recordDetermination({
      applicationNumber: appNum,
      documentIdentifier: d.documentIdentifier,
      code: d.documentCode,
      type: DET_CODES[d.documentCode],
      officialDate: d.officialDate,
      groupArtUnit: meta.groupArtUnit,
      examiner: meta.examiner,
    });
    if (isNew) found++;
  }
  // Requester type (patent owner vs third-party): the reliable signal is the
  // RXOSUB.R transaction event, so union the documents with the transactions feed.
  const txnCodes = await fetchTransactions(appNum).catch(() => []);
  const requesterType = classifyRequester([...docs.map((d) => d.documentCode), ...txnCodes]);
  if (requesterType !== 'unknown') await setRequesterType(appNum, requesterType);
  await markReexamScanned(appNum, true);
  return found;
}

export default async function handler(req, res) {
  // Accept the secret from the Authorization header (with or without "Bearer ")
  // or from a ?key= query param. Whitespace is trimmed. Enforced only if set.
  const secret = (process.env.CRON_SECRET || '').trim();
  const provided = ((req.headers.authorization || '').replace(/^Bearer\s+/i, '')
    || (req.query && req.query.key) || '').trim();
  if (secret && provided !== secret) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  try {
    // One shared deadline for the whole run. Each step below caps its own budget
    // against this, so later steps shrink (or skip) when earlier ones run long,
    // keeping the function under its maxDuration instead of summing independent
    // per-step deadlines.
    const runDeadline = Date.now() + 55000;
    const state = await reexamState();

    // 0) One-time: when the requester-type logic version changes, clear every
    // stored requester_type so the rolling backfill (step 2c) recomputes it with
    // the current transaction-based detection.
    let requesterReset = null;
    if ((state.requester_logic_v || 0) < REQUESTER_LOGIC_V) {
      try { requesterReset = await resetRequesterTypes(); await setRequesterLogicVersion(REQUESTER_LOGIC_V); }
      catch (e) { requesterReset = { error: String(e.message || e) }; }
    }

    // 1) Enumerate once/day.
    let enumerated = null;
    if (hoursSince(state.last_enumerated_at) >= 20) {
      try { enumerated = await enumerate(); }
      catch (e) { enumerated = { error: String(e.message || e) }; }
    }

    // 1b) Once/day: precompute the pre-order coverage denominators (total reexams
    // filed since the cutoff + those whose 30-day window elapsed) so the pre-order
    // page reads them from the DB instead of making live USPTO searches per view.
    let preorderCounts = null;
    try {
      const pc = await getPreorderCounts();
      if (hoursSince(pc.preorder_counts_at) >= 20) {
        const cov = await fetchPreorderCoverage(PREORDER_CUTOFF);
        await setPreorderCounts(cov.totalFiled, cov.deadlinePassed);
        preorderCounts = cov;
      }
    } catch (e) { preorderCounts = { error: String(e.message || e) }; }

    // 2) Scan a chunk (rolling, least-recently-scanned first).
    const batch = await getReexamScanBatch(SCAN_BATCH);
    let newDeterminations = 0;
    const errors = [];
    for (let i = 0; i < batch.length; i += CONCURRENCY) {
      const slice = batch.slice(i, i + CONCURRENCY).map(async (row) => {
        try { newDeterminations += await scanOne(row.application_number, row.filing_date); }
        catch (e) { errors.push({ application: row.application_number, error: String(e.message || e) }); }
      });
      await Promise.all(slice);
    }

    // 2b) Backfill examiner / group art unit for older determinations missing
    // them (one metadata fetch per application; self-completes over a few runs).
    let backfilled = 0;
    const backfillApps = await getAppsMissingDeterminationMeta(10);
    for (let i = 0; i < backfillApps.length; i += CONCURRENCY) {
      const slice = backfillApps.slice(i, i + CONCURRENCY).map(async (appNum) => {
        try {
          const m = await fetchMetaData(appNum);
          await updateDeterminationMeta(appNum, m.groupArtUnit, m.examiner);
          backfilled++;
        } catch { /* leave for a later run */ }
      });
      await Promise.all(slice);
    }

    // 2c) Backfill requester type (patent owner vs third-party) for determinations
    // missing it — union the documents + transactions feeds (third-party markers
    // can appear in either: RXOSUB.R in transactions, RXC/SR in documents, etc.).
    // Self-completes over runs.
    let requesterBackfilled = 0;
    const reqApps = await getAppsMissingRequesterType(12);
    for (let i = 0; i < reqApps.length; i += CONCURRENCY) {
      const slice = reqApps.slice(i, i + CONCURRENCY).map(async (appNum) => {
        try {
          const [docCodes, txnCodes] = await Promise.all([
            fetchDocuments(appNum).then((d) => d.map((x) => x.documentCode)).catch(() => []),
            fetchTransactions(appNum), // throws on error → retry next run
          ]);
          await setRequesterType(appNum, classifyRequester([...docCodes, ...txnCodes]));
          requesterBackfilled++;
        } catch { /* network/HTTP error — leave NULL and retry next run */ }
      });
      await Promise.all(slice);
    }

    // 3b) Public subscriber digest (8:00 AM PT): comprehensive list of the prior
    // day's relevant filings, sent to every subscriber.
    let subscriberDigest = { skipped: true };
    try { subscriberDigest = await maybeSendSubscriberDigest(req); }
    catch (e) { subscriberDigest = { error: String(e.message || e) }; }

    // 3c) Detect the reexamination certificate (RXCERT) for ordered reexams so we
    // can flag concluded proceedings. Rolling and capped per run. We no longer
    // parse the claim outcome from the PDF text (most certificates are scanned
    // images without extractable text); the column just shows "Concluded" + the
    // certificate document.
    let conclusions = { skipped: true };
    try {
      const detect = await detectConclusionsStep(5, Math.min(Date.now() + 8000, runDeadline));
      conclusions = { detect };
    } catch (e) { conclusions = { error: String(e.message || e) }; }

    // 3d) Detect post-order patent owner petitions (PET.OP) + opposition/decision
    // on ordered reexams. Rolling and capped per run.
    let petitions = { skipped: true };
    try {
      const apps = await getOrderedReexamsToCheckPetitions(12);
      const pDeadline = Math.min(Date.now() + 10000, runDeadline);
      let detected = 0;
      for (let i = 0; i < apps.length && Date.now() < pDeadline; i += 4) {
        await Promise.all(apps.slice(i, i + 4).map(async (a) => {
          try { detected += await detectPostOrderPetitionForApp(a.application_number, a.order_date); } catch { /* retry next run */ }
        }));
      }
      // OCR one petition decision (OCR.space) per run: flag 325(d) + store a
      // searchable PDF in Blob.
      let ocrDone = 0;
      if (ocrConfigured()) {
        const todo = await getDecisionsToStartOcr(1);
        for (const r of todo) {
          if (Date.now() > Math.min(pDeadline + 25000, runDeadline)) break;
          try { const res = await ocrDecision(r.application_number, r.decision_doc_id); await setDecisionOcrDone(r.application_number, res.is325d, res.blobUrl); ocrDone++; }
          catch { await setDecisionOcrFailed(r.application_number); }
        }
      }
      petitions = { scanned: apps.length, detected, ocrDone };
    } catch (e) { petitions = { error: String(e.message || e) }; }

    // 3e) Office action timing: find first non-final / final action dates for
    // ordered reexams per run (rolling, daily cooldown, re-checks until a final
    // action issues). Processed in small concurrent batches for throughput so a
    // newly-issued action is detected within about a day.
    let actions = { skipped: true };
    try {
      const aApps = await getOrderedReexamsToCheckActions(12);
      const aDeadline = Math.min(Date.now() + 12000, runDeadline);
      let aChecked = 0;
      for (let i = 0; i < aApps.length && Date.now() < aDeadline; i += 4) {
        await Promise.all(aApps.slice(i, i + 4).map(async (a) => {
          try { await detectActionsForApp(a.application_number, a.order_date); aChecked++; } catch { /* retry next run */ }
        }));
      }
      actions = { checked: aChecked };
    } catch (e) { actions = { error: String(e.message || e) }; }

    // 3f) Resolve the underlying-patent technology center for a few determinations
    // per run (two-hop continuity -> underlying app -> group art unit -> TC).
    let techCenters = { skipped: true };
    try {
      const tRows = await getDeterminationsToCheckTechCenter(3);
      const tDeadline = Math.min(Date.now() + 8000, runDeadline);
      let resolved = 0;
      for (const r of tRows) { if (Date.now() > tDeadline) break; try { const x = await detectTechCenterForApp(r.application_number); if (x.found) resolved++; } catch { /* retry next run */ } }
      techCenters = { checked: tRows.length, resolved };
    } catch (e) { techCenters = { error: String(e.message || e) }; }

    // 3g) Petition §325(d) detection — TEXT ONLY in the cron (fast). Image-only
    // petitions are flagged 'pending_ocr' and left to the ?petition325d=1 backfill
    // so a slow OCR call can't blow this function's time budget.
    let petition325d = { skipped: true };
    try {
      const prows = await getPetitionsToCheck325d(3);
      const pDeadline = Math.min(Date.now() + 6000, runDeadline);
      let resolved = 0, deferred = 0;
      for (const r of prows) {
        if (Date.now() > pDeadline) break;
        try {
          const x = await detectPetition325d(r.application_number, r.petition_doc_id, { allowOcr: false, downloadMs: 12000 });
          if (x.is325d === null) { await setPetition325dPendingOcr(r.application_number); deferred++; }
          else { await setPetition325dDone(r.application_number, x.is325d); resolved++; }
        } catch { await setPetition325dFailed(r.application_number); }
      }
      petition325d = { checked: prows.length, resolved, deferred };
    } catch (e) { petition325d = { error: String(e.message || e) }; }

    // 3h) Refresh ACTIVE post-order petitions (have a petition, no decision yet)
    // daily, so a newly-filed requester opposition or Office decision shows up
    // within a day instead of waiting on the 7-day discovery cooldown.
    let petitionRefresh = { skipped: true };
    try {
      const apps = await getActivePetitionsToRefresh(8);
      const rDeadline = Math.min(Date.now() + 8000, runDeadline);
      let refreshed = 0;
      for (const a of apps) { if (Date.now() > rDeadline) break; try { await detectPostOrderPetitionForApp(a.application_number, a.order_date); refreshed++; } catch { /* retry next run */ } }
      petitionRefresh = { checked: apps.length, refreshed };
    } catch (e) { petitionRefresh = { error: String(e.message || e) }; }

    // 3i) Pull all-AIA-year PTAB proceedings for a batch of reexam patents (least-
    // recently-scanned first) so the IPR→reexam pipeline stays current. Resumable;
    // each patent is re-checked ~every 14 days, and new patents are picked up as
    // their reexams resolve an underlying_patent above.
    let patentProceedings = { skipped: true };
    try {
      const STALE = new Date(Date.now() - 14 * 86400000).toISOString();
      const ppDeadline = Math.min(Date.now() + 10000, runDeadline);
      const patents = await getPatentsToScanForProceedings(60, STALE);
      let checked = 0, upserted = 0;
      for (const patent of patents) {
        if (Date.now() > ppDeadline) break;
        try {
          const prcs = await fetchProceedingsByPatent(patent);
          for (const r of prcs) { try { await upsertPatentProceeding(r); upserted++; } catch { /* skip bad row */ } }
          await markPatentProceedingsScanned(patent);
          checked++;
        } catch { /* retry next run */ }
      }
      patentProceedings = { checked, upserted, due: patents.length };
    } catch (e) { patentProceedings = { error: String(e.message || e) }; }

    // 3j) Rolling decisions sweep: walk a stored offset through the institution +
    // discretionary decision history (one page per feed per run), upserting each,
    // so ptab_decisions self-heals across ALL history independent of the daily
    // maintain window. New decisions are also captured by the digest upsert above.
    let decisionsSweep = { skipped: true };
    try {
      const swDeadline = Math.min(Date.now() + 8000, runDeadline);
      decisionsSweep = {};
      for (const feed of ['inst', 'dd']) {
        if (Date.now() > swDeadline) break;
        const key = 'dscan_off_' + feed;
        const off = parseInt((await getPtabKv(key)) || '0', 10) || 0;
        const page = feed === 'dd' ? await fetchDdPage({ offset: off, limit: 100 }) : await fetchInstitutionPage({ offset: off, limit: 100 });
        for (const r of page.rows) { try { if (feed === 'dd') await upsertPtabDd(r); else await upsertPtabInstitution(r); } catch { /* skip bad row */ } }
        const next = page.fetched < 100 ? 0 : off + 100; // wrap to newest at the end
        await setPtabKv(key, String(next));
        decisionsSweep[feed] = { offset: off, fetched: page.fetched, upserted: page.rows.length, next };
      }
    } catch (e) { decisionsSweep = { error: String(e.message || e) }; }

    // Counts so you can right-size the batch: remaining = still-to-scan this cycle.
    const counts = await reexamCounts();

    res.status(200).json({
      ok: true,
      enumerated,
      preorderCounts,
      scanned: batch.length,
      newDeterminations,
      backfilled,
      requesterReset,
      requesterBackfilled,
      counts, // { total, remaining, determined }
      subscriberDigest,
      conclusions,
      petitions,
      actions,
      techCenters,
      petition325d,
      petitionRefresh,
      patentProceedings,
      decisionsSweep,
      errors,
    });
  } catch (err) {
    res.status(500).json({ error: 'Reexam scan failed.', detail: String(err.message || err) });
  }
}
