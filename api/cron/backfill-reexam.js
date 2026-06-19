// On-demand backfill of examiner name + group art unit for existing reexam
// determinations (rather than waiting for the hourly reexam-scan to do 10/run).
// Trigger manually: GET /api/cron/backfill-reexam?key=<CRON_SECRET>
// Processes as many as it can within a time budget, then returns how many remain.
// If "done" is false, call it again until done is true.

import {
  getAppsMissingDeterminationMeta, updateDeterminationMeta, resetEmptyDeterminationMeta,
  getOrderedReexamsToCheckPetitions, resetPetitionScan,
  getDecisionsToStartOcr, setDecisionOcrDone, setDecisionOcrFailed, countDecisionsOcrPending, resetFailedDecisionOcr,
  getPetitionsToCheck325d, getPetitionsPendingOcr, setPetition325dDone, setPetition325dPendingOcr, setPetition325dFailed, countPetitions325dPending, resetFailedPetition325d, resetDonePetition325dFalse,
  getOrderedReexamsToCheckActions, countActionsToCheck, resetReexamActions,
  getDeterminationsToCheckConclusion, recordConclusionDocs,
  getConclusionsToParse, setConclusionOutcome, resetConclusionParse, resetAllConclusionParse,
  getDeterminationsToCheckTechCenter, countTechCenterToCheck, resetFailedTechCenter,
  upsertReexams, getReexamsNeverScanned, countUnscannedReexams, markReexamScanned, recordDetermination, resetReexamDeterminedSince,
} from '../../lib/db.js';
import { searchApplications, fetchDocuments, fetchMetaData } from '../../lib/uspto.js';
import { detectPostOrderPetitionForApp, detectPetition325d } from '../../lib/petitions.js';
import { detectCertificateOutcome } from '../../lib/conclusions.js';
import { detectTechCenterForApp } from '../../lib/techcenter.js';
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

  // Per-call time budget. Defaults to ~50s (just under the 60s function limit).
  // Pass ?maxSeconds=25 so the call returns before a scheduler's request timeout
  // (e.g. cron-job.org's free 30s cap); it just does less per run, so run it more
  // often or repeatedly until done.
  const budgetMs = (req.query && req.query.maxSeconds)
    ? Math.max(5000, Math.min(55000, Math.round(Number(req.query.maxSeconds) * 1000) || TIME_BUDGET_MS))
    : TIME_BUDGET_MS;

  try {
    // ?actions=1 — backfill office action timing (first non-final / final action
    // dates) for ordered reexams since the cutoff. Resumable; run until done.
    if (req.query && req.query.actions === '1') {
      // ?reset=1 clears existing rows so everything re-scans (e.g., to backfill doc ids).
      if (req.query.reset === '1') await resetReexamActions();
      const deadline = Date.now() + budgetMs;
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
      const deadline = Date.now() + budgetMs;
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

    // ?techcenter=1 — backfill the underlying-patent technology center for all
    // determinations (two-hop: reexam continuity -> underlying app -> group art
    // unit -> TC). Resumable; run until done is true.
    //   &retry=1 first re-pools rows that were checked but never resolved a TC
    //   (e.g. the second-hop call was throttled), so they get another attempt.
    // Lower concurrency than other modes because each app makes TWO USPTO calls;
    // running 5 in parallel (~10 in flight) trips ODP rate limits and silently
    // leaves blanks.
    if (req.query && req.query.techcenter === '1') {
      let repooled = 0;
      if (req.query.retry === '1') repooled = await resetFailedTechCenter();
      const deadline = Date.now() + budgetMs;
      const TC_CONCURRENCY = 3;
      let checked = 0, resolved = 0;
      while (Date.now() < deadline) {
        const rows = await getDeterminationsToCheckTechCenter(TC_CONCURRENCY);
        if (!rows.length) break;
        await Promise.all(rows.map(async (r) => {
          try { const x = await detectTechCenterForApp(r.application_number); checked++; if (x.found) resolved++; }
          catch { /* leave for a later call */ }
        }));
      }
      const remaining = await countTechCenterToCheck();
      res.status(200).json({ ok: true, mode: 'techcenter', repooled, checked, resolved, remaining, done: remaining === 0 });
      return;
    }

    // ?petition325d=1 — determine whether each patent owner petition cites 35
    // U.S.C. 325(d): text-first, OCR fallback for image-only petitions. Petitions
    // determined NOT to cite 325(d) drop off the petitions page. Resumable.
    //   &retry=1 first re-pools petitions whose prior attempt failed.
    // One petition per loop iteration; OCR is page-capped so each stays well
    // under the function limit.
    if (req.query && req.query.petition325d === '1') {
      let repooled = 0;
      if (req.query.retry === '1') repooled += await resetFailedPetition325d();
      // &recheck=1 re-pools petitions previously resolved as NOT citing 325(d) so
      // image-only false negatives get another (OCR) pass. Re-checks ALL such
      // petitions, so it can be a large OCR job — run it repeatedly until done.
      if (req.query.recheck === '1') repooled += await resetDonePetition325dFalse();
      const deadline = Date.now() + budgetMs;
      let checked = 0, cite325d = 0, failed = 0, ocrChecked = 0, rateLimited = false;
      const errors = [];
      const pushErr = (app, e) => { if (errors.length < 4) errors.push({ application: app, error: String(e && e.message || e) }); };

      // Phase 1 — text-only pass over never-touched petitions: resolves the
      // text-layer ones and flags image-only ones 'pending_ocr'. No OCR here, so
      // no OCR rate limits. Process ONE petition at a time with a generous
      // download timeout — firing several USPTO downloads in parallel got our
      // server throttled (403 / timeouts), while single sequential downloads
      // (like an interactive View) succeed.
      const remainMs = () => deadline - Date.now();
      // Per-item download timeout scaled to the budget, so a short (?maxSeconds)
      // call still does useful text work instead of nothing.
      const dlMs = Math.min(38000, Math.max(10000, budgetMs - 4000));
      let textDrained = false;
      while (remainMs() > dlMs) {
        const batch = await getPetitionsToCheck325d(1);
        if (!batch.length) { textDrained = true; break; }
        const r = batch[0];
        try {
          const x = await detectPetition325d(r.application_number, r.petition_doc_id, { allowOcr: false, downloadMs: dlMs });
          if (x.is325d === null) { await setPetition325dPendingOcr(r.application_number); }
          else { await setPetition325dDone(r.application_number, !!x.is325d); checked++; if (x.is325d) cite325d++; }
        } catch (e) { await setPetition325dFailed(r.application_number); failed++; pushErr(r.application_number, e); }
      }

      // Phase 2 — OCR the image-only ones, once the text pass is drained. OCR is
      // slow (~20-45s/item), so it only runs when enough budget remains for one
      // item — i.e. a full run with no (or large) ?maxSeconds. Short cron calls do
      // the text pass and leave OCR for a longer run. On a 429 (OCR.space rate/daily
      // cap) we STOP and leave the petition pending so it retries — never failed.
      if (textDrained) {
        while (remainMs() > 40000) {
          const todo = await getPetitionsPendingOcr(1);
          if (!todo.length) break;
          const r = todo[0];
          try {
            const x = await detectPetition325d(r.application_number, r.petition_doc_id, { allowOcr: true, downloadMs: 20000, ocrChunks: 2 });
            await setPetition325dDone(r.application_number, !!x.is325d); checked++; ocrChecked++; if (x.is325d) cite325d++;
          } catch (e) {
            const msg = String(e && e.message || e);
            if (/\b429\b/.test(msg) || /too many requests|rate ?limit/i.test(msg)) { rateLimited = true; pushErr(r.application_number, e); break; }
            await setPetition325dFailed(r.application_number); failed++; pushErr(r.application_number, e);
          }
        }
      }

      const remaining = await countPetitions325dPending();
      res.status(200).json({ ok: true, mode: 'petition325d', repooled, checked, ocrChecked, cite325d, failed, rateLimited, errors, remaining, done: remaining === 0 });
      return;
    }

    // ?outcomes=1 — OCR each reexamination certificate (or NIRC) and parse the
    // claim disposition (confirmed / cancelled / amended / new). OCR is slow, so a
    // new item only starts when ~40s of budget remains — i.e. a full run with no
    // (or large) ?maxSeconds. &retry=1 re-pools certificates that parsed to no
    // outcome (e.g. an image-only cert an earlier OCR pass missed).
    if (req.query && req.query.outcomes === '1') {
      let repooled = 0;
      if (req.query.reparse === '1') repooled = await resetAllConclusionParse();
      else if (req.query.retry === '1') repooled = await resetConclusionParse();
      const deadline = Date.now() + budgetMs;
      const remainMs = () => deadline - Date.now();
      let checked = 0, parsedOut = 0, failed = 0, rateLimited = false;
      const errors = [];
      const pushErr = (app, e) => { if (errors.length < 4) errors.push({ application: app, error: String(e && e.message || e) }); };
      while (remainMs() > 40000) {
        const todo = await getConclusionsToParse(1);
        if (!todo.length) break;
        const r = todo[0];
        try {
          const x = await detectCertificateOutcome(r.application_number, r.cert_doc_id, r.nirc_doc_id, { allowOcr: true, downloadMs: 20000, ocrChunks: 3 });
          await setConclusionOutcome(r.application_number, x.outcome); checked++; if (x.outcome) parsedOut++;
        } catch (e) {
          const msg = String(e && e.message || e);
          if (/\b429\b/.test(msg) || /too many requests|rate ?limit/i.test(msg)) { rateLimited = true; pushErr(r.application_number, e); break; }
          // Mark attempted (no outcome) so a persistently-failing cert can't block
          // the queue; &retry=1 re-pools it later.
          try { await setConclusionOutcome(r.application_number, null); } catch { /* ignore */ }
          failed++; pushErr(r.application_number, e);
        }
      }
      const remaining = (await getConclusionsToParse(100000)).length;
      res.status(200).json({ ok: true, mode: 'outcomes', repooled, checked, parsedOutcomes: parsedOut, failed, rateLimited, errors, remaining, done: remaining === 0 });
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
      const deadline = Date.now() + budgetMs;
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
      // ?reset=1 clears the scan cooldown so every ordered reexam is re-checked.
      if (req.query.reset === '1') await resetPetitionScan();
      const deadline = Date.now() + budgetMs;
      let scanned = 0, detected = 0;
      while (Date.now() < deadline) {
        const apps = await getOrderedReexamsToCheckPetitions(CONCURRENCY);
        if (!apps.length) break;
        // Concurrent metadata fetches (like the actions backfill) for throughput.
        await Promise.all(apps.map(async (a) => {
          try { detected += await detectPostOrderPetitionForApp(a.application_number, a.order_date); scanned++; }
          catch { /* leave unscanned; retried next call */ }
        }));
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

    const deadline = Date.now() + budgetMs;
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
