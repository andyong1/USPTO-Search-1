// Reexamination determinations watcher (ex parte, 90/ series).
// Triggered by cron-job.org (hourly) with Authorization: Bearer <CRON_SECRET>.
//
// Each run:
//   1. Once/day: enumerate ex parte reexams filed in the last 6 months into
//      reexam_watch (and prune ones older than ~9 months).
//   2. Scan the next chunk of not-yet-determined reexams for RXREXO (reexam
//      ordered) / RXREXD (reexam denied) documents; record any new ones.
//   3. Once/day: email a digest of newly found determinations (REEXAM_DIGEST_TO).
//
// Work is chunked across hourly runs (rolling, least-recently-scanned first) so
// each invocation stays small enough for Vercel Hobby limits.

import {
  reexamState, setReexamEnumerated, setReexamDigestSent,
  upsertReexams, pruneReexams, getReexamScanBatch, markReexamScanned,
  recordDetermination, getUnnotifiedDeterminations, markAllDeterminationsNotified,
  reexamCounts, getAppsMissingDeterminationMeta, updateDeterminationMeta,
  recordPreorder, updatePreorderPetition, PREORDER_CUTOFF,
  listDeterminationsByOfficialDate, listReexamSubscribers, getSubDigestDate, setSubDigestDate,
  getDeterminationsToCheckConclusion, recordConclusionDocs, getConclusionsToParse, setConclusionOutcome,
  getOrderedReexamsToCheckPetitions,
  getDecisionsToStartOcr, setDecisionOcrDone, setDecisionOcrFailed,
  getOrderedReexamsToCheckActions,
} from '../../lib/db.js';
import { searchApplications, fetchDocuments, fetchMetaData, analyzePetition, fetchDocumentBytes } from '../../lib/uspto.js';
import { sendReexamDigest, sendReexamSubscriberDigest } from '../../lib/email.js';
import { extractPdfText, parseReexamOutcome } from '../../lib/reexamOutcome.js';
import { detectPostOrderPetitionForApp } from '../../lib/petitions.js';
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

// Send the once-daily subscriber digest of determinations issued the previous PT
// day. Only the scan run that lands in the 8 AM PT hour sends it (so the hourly
// scan does not email every run); other hours are skipped. Skips entirely when
// no determinations issued. ?forceSubEmail=1 (with date optional) bypasses the gate.
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

  const determinations = await listDeterminationsByOfficialDate(targetDate);
  // Mark the day handled even when empty, so we check at most once per day.
  if (!force) await setSubDigestDate(targetDate);

  if (!determinations.length) return { date: targetDate, determinations: 0, sent: 0 };

  const subscribers = await listReexamSubscribers();
  const base = baseUrl(req);
  const dateLabel = prettyDate(targetDate);
  let sent = 0; const errors = [];
  for (const s of subscribers) {
    const r = await sendReexamSubscriberDigest(s.email, determinations, {
      dateLabel, unsubscribeUrl: `${base}/api/reexam-subscribe?token=${encodeURIComponent(s.token)}`,
    });
    if (r && r.sent) sent++;
    else if (r && (r.error || r.skipped)) errors.push({ email: s.email, reason: r.error || r.reason });
  }
  return { date: targetDate, determinations: determinations.length, subscribers: subscribers.length, sent, errors };
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
      let nirc = null, cert = null;
      for (const d of docs) {
        const code = (d.documentCode || '').toUpperCase();
        if (code === 'RXNIRC' && !nirc) nirc = d;
        if (code === 'RXCERT' && !cert) cert = d;
      }
      await recordConclusionDocs(app, {
        nircDocId: nirc && nirc.documentIdentifier, nircDate: nirc && nirc.officialDate,
        certDocId: cert && cert.documentIdentifier, certDate: cert && cert.officialDate,
      });
      if (nirc || cert) found++;
    } catch (e) { errors.push({ application: app, error: String(e.message || e) }); }
  }
  return { checked: rows.length, concluded: found, errors };
}

// Parse the claim outcome from the certificate/NIRC PDF text. Heavier (downloads
// + parses a PDF), so a small cap per run.
async function parseConclusionsStep(maxDocs, deadline) {
  const rows = await getConclusionsToParse(maxDocs);
  let parsed = 0;
  const errors = [];
  for (const r of rows) {
    if (Date.now() > deadline) break;
    const docId = r.cert_doc_id || r.nirc_doc_id;
    if (!docId) continue;
    let buffer;
    try { ({ buffer } = await fetchDocumentBytes(r.application_number, docId, 'PDF')); }
    catch (e) { errors.push({ application: r.application_number, error: String(e.message || e) }); continue; } // retry next run
    const text = await extractPdfText(buffer);
    const outcome = text ? parseReexamOutcome(text) : null;
    await setConclusionOutcome(r.application_number, outcome); // marks parsed=true
    parsed++;
  }
  return { parsed, errors };
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
    const state = await reexamState();

    // 1) Enumerate once/day.
    let enumerated = null;
    if (hoursSince(state.last_enumerated_at) >= 20) {
      try { enumerated = await enumerate(); }
      catch (e) { enumerated = { error: String(e.message || e) }; }
    }

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

    // 3) Daily digest of newly found determinations.
    let digest = { skipped: true };
    if (hoursSince(state.last_digest_at) >= 23) {
      const pending = await getUnnotifiedDeterminations();
      if (pending.length) {
        try { digest = await sendReexamDigest(pending); await markAllDeterminationsNotified(); }
        catch (e) { digest = { error: String(e.message || e) }; }
      }
      await setReexamDigestSent();
    }

    // 3b) Public subscriber digest (8:00 AM PT, only on days with determinations).
    let subscriberDigest = { skipped: true };
    try { subscriberDigest = await maybeSendSubscriberDigest(req); }
    catch (e) { subscriberDigest = { error: String(e.message || e) }; }

    // 3c) Detect NIRC/certificate (conclusion) for ordered reexams, then parse the
    // claim outcome from a couple of those PDFs. Both rolling and capped per run.
    let conclusions = { skipped: true };
    try {
      const detect = await detectConclusionsStep(5, Date.now() + 8000);
      const parse = await parseConclusionsStep(1, Date.now() + 12000);
      conclusions = { detect, parse };
    } catch (e) { conclusions = { error: String(e.message || e) }; }

    // 3d) Detect post-order patent owner petitions (PET.OP) + opposition/decision
    // on ordered reexams. Rolling and capped per run.
    let petitions = { skipped: true };
    try {
      const apps = await getOrderedReexamsToCheckPetitions(5);
      const pDeadline = Date.now() + 10000;
      let detected = 0;
      for (const a of apps) { if (Date.now() > pDeadline) break; try { detected += await detectPostOrderPetitionForApp(a.application_number, a.order_date); } catch { /* retry next run */ } }
      // OCR one petition decision (OCR.space) per run: flag 325(d) + store a
      // searchable PDF in Blob.
      let ocrDone = 0;
      if (ocrConfigured()) {
        const todo = await getDecisionsToStartOcr(1);
        for (const r of todo) {
          if (Date.now() > pDeadline + 25000) break;
          try { const res = await ocrDecision(r.application_number, r.decision_doc_id); await setDecisionOcrDone(r.application_number, res.is325d, res.blobUrl); ocrDone++; }
          catch { await setDecisionOcrFailed(r.application_number); }
        }
      }
      petitions = { scanned: apps.length, detected, ocrDone };
    } catch (e) { petitions = { error: String(e.message || e) }; }

    // 3e) Office-action timing: find first non-final / final action dates for a
    // few ordered reexams per run (rolling, re-checks until a final action issues).
    let actions = { skipped: true };
    try {
      const aApps = await getOrderedReexamsToCheckActions(5);
      const aDeadline = Date.now() + 8000;
      for (const a of aApps) { if (Date.now() > aDeadline) break; try { await detectActionsForApp(a.application_number, a.order_date); } catch { /* retry next run */ } }
      actions = { checked: aApps.length };
    } catch (e) { actions = { error: String(e.message || e) }; }

    // Counts so you can right-size the batch: remaining = still-to-scan this cycle.
    const counts = await reexamCounts();

    res.status(200).json({
      ok: true,
      enumerated,
      scanned: batch.length,
      newDeterminations,
      backfilled,
      counts, // { total, remaining, determined }
      digest,
      subscriberDigest,
      conclusions,
      petitions,
      actions,
      errors,
    });
  } catch (err) {
    res.status(500).json({ error: 'Reexam scan failed.', detail: String(err.message || err) });
  }
}
