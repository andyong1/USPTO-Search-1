// On-demand backfill of examiner name + group art unit for existing reexam
// determinations (rather than waiting for the hourly reexam-scan to do 10/run).
// Trigger manually: GET /api/cron/backfill-reexam?key=<CRON_SECRET>
// Processes as many as it can within a time budget, then returns how many remain.
// If "done" is false, call it again until done is true.

import {
  getAppsMissingDeterminationMeta, updateDeterminationMeta, resetEmptyDeterminationMeta,
  getOrderedReexamsToCheckPetitions, resetPetitionScan,
  getDecisionsToStartOcr, setDecisionOcrDone, setDecisionOcrFailed, countDecisionsOcrPending, resetFailedDecisionOcr,
  getOrderedReexamsToCheckActions, countActionsToCheck, resetReexamActions,
  getDeterminationsToCheckConclusion, recordConclusionDocs,
  upsertReexams, getReexamsNeverScanned, countUnscannedReexams, markReexamScanned, recordDetermination, resetReexamDeterminedSince,
} from '../../lib/db.js';
import { searchApplications, fetchDocuments, fetchMetaData } from '../../lib/uspto.js';
import { detectPostOrderPetitionForApp } from '../../lib/petitions.js';
import { ocrConfigured, ocrDecision } from '../../lib/ocr.js';
import { detectActionsForApp } from '../../lib/actions.js';

export const config = { maxDuration: 60 };

const CONCURRENCY = 5;
const TIME_BUDGET_MS = 50000; // stop before the 60s function limit
const DET_CODES = { RXREXO: 'Reexam Ordered', RXREXD: 'Reexam Denied' };

export default async function handler(req, res) {
  const secret = (process.env.CRON_SECRET || '').trim();
  const provided = ((req.headers.authorization || '').replace(/^Bearer\s+/i, '')
    || (req.query && req.query.key) || '').trim();
  if (secret && provided !== secret) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  try {
    // ?actions=1 — backfill office action timing (first non-final / final action
    // dates) for ordered reexams since the cutoff. Resumable; run until done.
    if (req.query && req.query.actions === '1') {
      // ?reset=1 clears existing rows so everything re-scans (e.g., to backfill doc ids).
      if (req.query.reset === '1') await resetReexamActions();
      const deadline = Date.now() + TIME_BUDGET_MS;
      let checked = 0;
      while (Date.now() < deadline) {
        const apps = await getOrderedReexamsToCheckActions(CONCURRENCY);
        if (!apps.length) break;
        await Promise.all(apps.map(async (a) => {
          try { await detectActionsForApp(a.application_number, a.order_date); checked++; }
          catch { /* leave for a later call */ }
        }));
      }
      const remaining = await countActionsToCheck();
      res.status(200).json({ ok: true, mode: 'actions', checked, remaining, done: remaining === 0 });
      return;
    }

    // ?conclusions=1 — backfill reexamination-certificate (RXCERT) detection for
    // all ordered reexams, so concluded proceedings are flagged immediately rather
    // than waiting for the hourly rolling scan (which checks only a few per run).
    // Resumable; run until done is true. No reset needed.
    if (req.query && req.query.conclusions === '1') {
      const deadline = Date.now() + TIME_BUDGET_MS;
      let checked = 0, concluded = 0;
      while (Date.now() < deadline) {
        const rows = await getDeterminationsToCheckConclusion(CONCURRENCY);
        if (!rows.length) break;
        await Promise.all(rows.map(async (r) => {
          try {
            const docs = await fetchDocuments(r.application_number);
            let nirc = null, cert = null;
            for (const d of docs) {
              const code = (d.documentCode || '').toUpperCase();
              if (code === 'RXNIRC' && !nirc) nirc = d;
              if (code === 'RXCERT' && !cert) cert = d;
            }
            await recordConclusionDocs(r.application_number, {
              nircDocId: nirc && nirc.documentIdentifier, nircDate: nirc && nirc.officialDate,
              certDocId: cert && cert.documentIdentifier, certDate: cert && cert.officialDate,
            });
            if (cert) concluded++;
            checked++;
          } catch { /* leave for a later call */ }
        }));
      }
      const remaining = (await getDeterminationsToCheckConclusion(100000)).length;
      res.status(200).json({ ok: true, mode: 'conclusions', checked, concluded, remaining, done: remaining === 0 });
      return;
    }

    // ?determinations=1 — recapture ALL ex parte reexam determinations. Enumerates
    // 90* reexams filed on/after ?from (default 2024-08-01, comfortably covering
    // determinations issued from Jan 1 2025 onward), re-pools them, and scans for
    // RXREXO/RXREXD. Resumable — run until done is true.
    //   first call: ?determinations=1&from=2024-08-01  (enumerates + re-pools)
    //   subsequent: ?determinations=1                  (keeps scanning the pool)
    if (req.query && req.query.determinations === '1') {
      const from = String(req.query.from || '2024-08-01');
      const deadline = Date.now() + TIME_BUDGET_MS;
      let enumerated = 0;

      // Enumerate the filing window into the watch table and re-pool it for
      // re-scanning. Only on the first call (when ?from is provided) to avoid
      // repeating the enumeration on every resume call.
      if (req.query.from) {
        let offset = 0;
        for (let page = 0; page < 40 && Date.now() < deadline; page++) {
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
          enumerated += items.length;
          offset += 100;
          if (hits.length < 100) break;
        }
        await resetReexamDeterminedSince(from);
      }

      // Scan the freshly-pooled (never-scanned) reexams for determinations.
      let scanned = 0, found = 0;
      while (Date.now() < deadline) {
        const batch = await getReexamsNeverScanned(CONCURRENCY);
        if (!batch.length) break;
        await Promise.all(batch.map(async (row) => {
          try {
            const docs = await fetchDocuments(row.application_number);
            const detDocs = docs.filter((d) => DET_CODES[d.documentCode]);
            if (detDocs.length) {
              const meta = await fetchMetaData(row.application_number).catch(() => ({}));
              for (const d of detDocs) {
                const isNew = await recordDetermination({
                  applicationNumber: row.application_number, documentIdentifier: d.documentIdentifier,
                  code: d.documentCode, type: DET_CODES[d.documentCode], officialDate: d.officialDate,
                  groupArtUnit: meta.groupArtUnit, examiner: meta.examiner,
                });
                if (isNew) found++;
              }
              await markReexamScanned(row.application_number, true);
            } else {
              await markReexamScanned(row.application_number, false);
            }
            scanned++;
          } catch { /* leave for a later call */ }
        }));
      }

      const remaining = await countUnscannedReexams();
      res.status(200).json({ ok: true, mode: 'determinations', from: req.query.from ? from : '(resume)', enumerated, scanned, found, remaining, done: remaining === 0 });
      return;
    }

    // ?petitions=1 — backfill post-order petitions (petition + opposition +
    // decision) across all ordered reexams. Run until done is true.
    if (req.query && req.query.petitions === '1') {
      // ?reset=1 clears the 7-day scan cooldown so every ordered reexam is re-checked.
      if (req.query.reset === '1') await resetPetitionScan();
      const deadline = Date.now() + TIME_BUDGET_MS;
      let scanned = 0, detected = 0;
      while (Date.now() < deadline) {
        const apps = await getOrderedReexamsToCheckPetitions(CONCURRENCY);
        if (!apps.length) break;
        for (const a of apps) {
          if (Date.now() > deadline) break;
          try { detected += await detectPostOrderPetitionForApp(a.application_number, a.order_date); scanned++; }
          catch { /* leave unscanned; retried next call */ }
        }
      }
      // OCR petition decisions (OCR.space) within the remaining budget. Resumable.
      // ?ocrretry=1 re-pools previously failed OCR attempts first.
      let ocrDone = 0, ocrFailed = 0;
      if (ocrConfigured()) {
        if (req.query.ocrretry === '1') await resetFailedDecisionOcr();
        // One decision at a time; stop starting a new one unless ~30s of budget
        // remains, so a slow multi-page OCR can't push us past the 60s limit.
        while (Date.now() < deadline - 30000) {
          const todo = await getDecisionsToStartOcr(1);
          if (!todo.length) break;
          const r = todo[0];
          try { const res = await ocrDecision(r.application_number, r.decision_doc_id); await setDecisionOcrDone(r.application_number, res.is325d, res.blobUrl); ocrDone++; }
          catch { await setDecisionOcrFailed(r.application_number); ocrFailed++; }
        }
      }
      const remainingScan = (await getOrderedReexamsToCheckPetitions(100000)).length;
      const remainingOcr = ocrConfigured() ? await countDecisionsOcrPending() : 0;
      res.status(200).json({
        ok: true, mode: 'petitions', scanned, detected,
        ocr: ocrConfigured() ? { done: ocrDone, failed: ocrFailed, remaining: remainingOcr } : 'OCR not configured',
        remainingScan, done: remainingScan === 0 && remainingOcr === 0,
      });
      return;
    }

    // ?reset=1 re-pools rows that previously ended up blank, so they get retried.
    let reset = 0;
    if (req.query && req.query.reset === '1') reset = await resetEmptyDeterminationMeta();

    const deadline = Date.now() + TIME_BUDGET_MS;
    let processed = 0;

    while (Date.now() < deadline) {
      const apps = await getAppsMissingDeterminationMeta(CONCURRENCY);
      if (!apps.length) break;
      await Promise.all(apps.map(async (appNum) => {
        try {
          const m = await fetchMetaData(appNum);
          await updateDeterminationMeta(appNum, m.groupArtUnit, m.examiner);
          processed++;
        } catch { /* mark nothing; will be retried on a later call */ }
      }));
    }

    const remaining = (await getAppsMissingDeterminationMeta(100000)).length;
    res.status(200).json({ ok: true, reset, processed, remaining, done: remaining === 0 });
  } catch (err) {
    res.status(500).json({ error: 'Backfill failed.', detail: String(err.message || err) });
  }
}
