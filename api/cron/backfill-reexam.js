// On-demand backfill of examiner name + group art unit for existing reexam
// determinations (rather than waiting for the hourly reexam-scan to do 10/run).
// Trigger manually: GET /api/cron/backfill-reexam?key=<CRON_SECRET>
// Processes as many as it can within a time budget, then returns how many remain.
// If "done" is false, call it again until done is true.

import {
  getAppsMissingDeterminationMeta, updateDeterminationMeta, resetEmptyDeterminationMeta,
  getOrderedReexamsToCheckPetitions, resetPetitionScan, getPetitionDecisionsToParse,
  upsertReexams, getReexamsNeverScanned, countUnscannedReexams, markReexamScanned, recordDetermination, resetReexamDeterminedSince,
} from '../../lib/db.js';
import { searchApplications, fetchDocuments, fetchMetaData } from '../../lib/uspto.js';
import { detectPostOrderPetitionForApp, parsePetitionDecision } from '../../lib/petitions.js';

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
    // ?determinations=1 — recapture ALL ex parte reexam determinations. Enumerates
    // 90* reexams filed on/after ?from (default 2025-08-01, comfortably covering
    // determinations issued from Dec 22 2025 onward), re-pools them, and scans for
    // RXREXO/RXREXD. Resumable — run until done is true.
    //   first call: ?determinations=1&from=2025-08-01  (enumerates + re-pools)
    //   subsequent: ?determinations=1                  (keeps scanning the pool)
    if (req.query && req.query.determinations === '1') {
      const from = String(req.query.from || '2025-08-01');
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
      // Parse petition decisions for a 325(d) analysis (within remaining budget).
      let decisionsParsed = 0, decisions325d = 0;
      const decs = await getPetitionDecisionsToParse(100);
      for (const r of decs) {
        if (Date.now() > deadline) break;
        try { if (await parsePetitionDecision(r)) decisions325d++; decisionsParsed++; }
        catch { /* retry next call */ }
      }
      const remainingScan = (await getOrderedReexamsToCheckPetitions(100000)).length;
      const remainingDecisions = (await getPetitionDecisionsToParse(100000)).length;
      res.status(200).json({
        ok: true, mode: 'petitions', scanned, detected, decisionsParsed, decisions325d,
        remainingScan, remainingDecisions, done: remainingScan === 0 && remainingDecisions === 0,
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
