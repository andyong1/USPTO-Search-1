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
} from '../../lib/db.js';
import { searchApplications, fetchDocuments, fetchMetaData, analyzePetition } from '../../lib/uspto.js';
import { sendReexamDigest } from '../../lib/email.js';

export const config = { maxDuration: 60 };

const SCAN_BATCH = 25;        // reexams scanned per run
const CONCURRENCY = 5;
const WINDOW_MONTHS = 6;      // enumerate reexams filed within this window
const PRUNE_MONTHS = 9;       // drop reexams older than this
const DET_CODES = { RXREXO: 'Reexam Ordered', RXREXD: 'Reexam Denied' };
const PREORDER_CODE = 'RX.PRO.PO'; // patent-owner pre-order SNQ submission

const isoMonthsAgo = (m) => { const d = new Date(); d.setMonth(d.getMonth() - m); return d.toISOString().slice(0, 10); };
const hoursSince = (ts) => (ts ? (Date.now() - new Date(ts).getTime()) / 3.6e6 : Infinity);

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

  // Patent-owner pre-order SNQ submissions (for reexams filed on/after cutoff),
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
      errors,
    });
  } catch (err) {
    res.status(500).json({ error: 'Reexam scan failed.', detail: String(err.message || err) });
  }
}
