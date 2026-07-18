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
  getDeterminationsToCheckConclusion, recordConclusionDocs, markCertRejected, resetConclusionCerts,
  getConclusionsToParse, getConclusionsToReparse, countConclusionsUnparsed, setConclusionOutcome, resetConclusionParse, resetAllConclusionParse, clearUnparsedCertText, getConclusionText,
  getCertsNeedingEngine2, countCertsNeedingEngine2, markCertEngine2,
  getDeterminationsToCheckTechCenter, countTechCenterToCheck, resetFailedTechCenter, reexamPatentResolutionBreakdown, backfillSeries96Requester,
  getDocsToExtractGrounds, setDocGrounds, countDocsToExtractGrounds, getFwdsToExtractGrounds, setFwdGrounds, countFwdsToExtractGrounds,
  upsertReexams, getReexamsNeverScanned, countUnscannedReexams, markReexamScanned, recordDetermination, resetReexamDeterminedSince,
} from '../../lib/db.js';
import { searchApplications, fetchDocuments, fetchMetaData, determinationLabel } from '../../lib/uspto.js';
import { detectPostOrderPetitionForApp, detectPetition325d } from '../../lib/petitions.js';
import { detectCertificateOutcome } from '../../lib/conclusions.js';
import { parseReexamOutcome, certCitesProceeding } from '../../lib/reexamOutcome.js';
import { detectTechCenterForApp } from '../../lib/techcenter.js';
import { ocrConfigured, ocrTextConfigured, ocrDecision } from '../../lib/ocr.js';
import { detectActionsForApp } from '../../lib/actions.js';
import { extractAllRefs, extractTrialNumbers } from '../../lib/grounds.js';
import { cronOk, clientErrorDetail } from '../../lib/secure.js';

export const config = { maxDuration: 60 };

// For debug: return the region of the certificate text around the claim
// disposition (which sits near the end of a certificate, after the cover and the
// full text of amended/new claims), so we can see the wording the parser missed.
function dispositionWindow(txt) {
  const t = String(txt || '').replace(/\s+/g, ' ');
  const m = t.match(/(result of reexamin|been determined|patentab|no amendment|claim\(?s?\)?\s+(confirmed|cancel|amended|patentable))/i);
  if (m) return t.slice(Math.max(0, m.index - 200), m.index + 2200);
  return t.slice(-3000);
}

const CONCURRENCY = 5;
const TIME_BUDGET_MS = 50000; // stop before the 60s function limit

export default async function handler(req, res) {
  // CRON gate — fails closed when CRON_SECRET is unset; constant-time compare.
  // Accepts Authorization: Bearer or (transitionally) ?key= (SEC-1/3/4).
  if (!cronOk(req)) {
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
      // &reset=1 clears the certificate side of every conclusion (keeping NIRC
      // dates) so detection re-finds RXCERTs and the parse step re-validates them.
      let reset = 0;
      if (req.query.reset === '1') reset = await resetConclusionCerts();
      const deadline = Date.now() + budgetMs;
      let checked = 0, concluded = 0;
      while (Date.now() < deadline) {
        const rows = await getDeterminationsToCheckConclusion(CONCURRENCY);
        if (!rows.length) break;
        await Promise.all(rows.map(async (r) => {
          try {
            const docs = await fetchDocuments(r.application_number);
            let nirc = null; const certs = [];
            for (const d of docs) {
              const code = (d.documentCode || '').toUpperCase();
              if (code === 'RXNIRC' && !nirc) nirc = d;
              if (code === 'RXCERT') certs.push({ id: d.documentIdentifier, date: d.officialDate });
            }
            await recordConclusionDocs(r.application_number, {
              nircDocId: nirc && nirc.documentIdentifier, nircDate: nirc && nirc.officialDate,
              certCandidates: certs,
            });
            if (certs.length) concluded++;
            checked++;
          } catch { /* leave for a later call */ }
        }));
      }
      const remaining = (await getDeterminationsToCheckConclusion(100000)).length;
      res.status(200).json({ ok: true, mode: 'conclusions', reset, checked, concluded, remaining, done: remaining === 0 });
      return;
    }

    // ?techcenter=1 — backfill the underlying-patent technology center for all
    // determinations (two-hop: reexam continuity -> underlying app -> group art
    // unit -> TC). Resumable; run until done is true.
    //   &retry=1 first re-pools rows that aren't fully resolved — no TC, or a TC but
    //   no underlying patent — so they get another attempt with the current resolver.
    // Lower concurrency than other modes because each app makes TWO USPTO calls;
    // running 5 in parallel (~10 in flight) trips ODP rate limits and silently
    // leaves blanks.
    if (req.query && req.query.techcenter === '1') {
      // &series=96 restricts the backfill to supplemental-exam-resulting EPRs
      // (e.g. to fill rows the determinations backfill added without enriching).
      const series = req.query.series ? String(req.query.series).replace(/[^0-9]/g, '') : null;
      let repooled = 0;
      if (req.query.retry === '1') repooled = await resetFailedTechCenter();
      // Series 96/ requester is patent_owner by statute — fill it in the same call
      // (instant SQL, no USPTO fetch) so a 96/ backfill covers TC + requester.
      const requesterSet = series === '96' ? await backfillSeries96Requester() : 0;
      const deadline = Date.now() + budgetMs;
      const TC_CONCURRENCY = 3;
      let checked = 0, resolved = 0;
      while (Date.now() < deadline) {
        const rows = await getDeterminationsToCheckTechCenter(TC_CONCURRENCY, series);
        if (!rows.length) break;
        await Promise.all(rows.map(async (r) => {
          try { const x = await detectTechCenterForApp(r.application_number); checked++; if (x.found) resolved++; }
          catch { /* leave for a later call */ }
        }));
      }
      const remaining = await countTechCenterToCheck(series);
      const breakdown = await reexamPatentResolutionBreakdown();
      res.status(200).json({ ok: true, mode: 'techcenter', series: series || 'all', repooled, requesterSet, checked, resolved, remaining, done: remaining === 0, breakdown });
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
      // Read-only inspector: ?outcomes=1&app=<num> returns one proceeding's cached
      // certificate text (disposition region) and how it currently parses — for
      // debugging the parser without mutating anything.
      if (req.query.app) {
        const info = await getConclusionText(String(req.query.app));
        const text = (info && info.cert_text) || '';
        res.status(200).json({
          ok: true, mode: 'outcomes-inspect', app: String(req.query.app),
          cert_doc_id: (info && info.cert_doc_id) || null,
          ocrEngine: (info && info.cert_ocr_engine) || null,
          textLen: text.replace(/\s/g, '').length,
          storedOutcome: (info && info.outcome_summary) || null,
          parsedNow: parseReexamOutcome(text),
          belongs: certCitesProceeding(text, String(req.query.app)),
          textSample: dispositionWindow(text),
        });
        return;
      }

      // ?outcomes=1&engine2all=1 — sweep EVERY certificate through Engine-2 OCR,
      // skipping ones already at engine 2 (resumable). Upgrades text+outcome in
      // place: a good engine-1 outcome is preserved if engine 2 yields none, so the
      // page never shows a gap. ~1 cert/call (OCR is slow) — run repeatedly/schedule.
      if (req.query.engine2all === '1') {
        const deadline2 = Date.now() + budgetMs;
        let ocrd = 0, parsed2 = 0, rej2 = 0, fail2 = 0, rl2 = false;
        const errs = [], samp = [];
        while (deadline2 - Date.now() > 40000) {
          const todo = await getCertsNeedingEngine2(1);
          if (!todo.length) break;
          const r = todo[0];
          try {
            const x = await detectCertificateOutcome(r.application_number, r.cert_doc_id, { allowOcr: true, downloadMs: 20000, ocrChunks: 3, ocrEngine: '2' });
            if (samp.length < 6) samp.push({ app: r.application_number, textLen: x.textLen, belongs: x.belongs, parsed: !!x.outcome });
            if (x.belongs === false) { await markCertRejected(r.application_number, r.cert_doc_id); rej2++; }
            else if (x.outcome) { await setConclusionOutcome(r.application_number, x.outcome, x.text, '2'); ocrd++; parsed2++; }
            else { await markCertEngine2(r.application_number, x.text); ocrd++; }
          } catch (e) {
            const msg = String(e && e.message || e);
            if (/\b429\b/.test(msg) || /too many requests|rate ?limit/i.test(msg)) { rl2 = true; if (errs.length < 4) errs.push({ application: r.application_number, error: msg }); break; }
            fail2++; if (errs.length < 4) errs.push({ application: r.application_number, error: msg });
          }
        }
        const eng2remaining = await countCertsNeedingEngine2();
        res.status(200).json({ ok: true, mode: 'engine2-sweep', ocrConfigured: ocrTextConfigured(), ocrd, parsedOutcomes: parsed2, rejected: rej2, failed: fail2, rateLimited: rl2, errors: errs, samples: samp, remaining: eng2remaining, done: eng2remaining === 0 });
        return;
      }

      let repooled = 0;
      if (req.query.reparse === '1') repooled = await resetAllConclusionParse();
      else if (req.query.reocr === '1') repooled = await clearUnparsedCertText();
      else if (req.query.retry === '1') repooled = await resetConclusionParse();
      // Engine 2 is OCR.space's more accurate model — used to re-OCR certificates
      // whose engine-1 text was too garbled to parse. Re-pool them with &reocr=1.
      const ocrEngine = req.query.engine2 === '1' ? '2' : '1';
      const deadline = Date.now() + budgetMs;
      const remainMs = () => deadline - Date.now();
      let checked = 0, parsedOut = 0, reparsed = 0, rejected = 0, failed = 0, rateLimited = false;
      const errors = [];
      const samples = [];
      const pushErr = (app, e) => { if (errors.length < 4) errors.push({ application: app, error: String(e && e.message || e) }); };

      // Phase 1 — re-parse certificates whose OCR text is already cached. Instant
      // (no download/OCR), so this drains the whole cached backlog in a call or two.
      while (remainMs() > 3000) {
        const batch = await getConclusionsToReparse(50);
        if (!batch.length) break;
        for (const r of batch) {
          if (samples.length < 6) {
            const s = { app: r.application_number, method: 'cache', textLen: r.cert_text ? r.cert_text.length : 0, belongs: certCitesProceeding(r.cert_text, r.application_number), parsed: !!parseReexamOutcome(r.cert_text) };
            // Under debug, surface the disposition region of the FIRST few certs
            // that still don't parse, so the wording can be matched.
            if (req.query.debug === '1' && !s.parsed && samples.filter((q) => q.textSample).length < 3) s.textSample = dispositionWindow(r.cert_text);
            samples.push(s);
          }
          const belongs = certCitesProceeding(r.cert_text, r.application_number);
          if (belongs === false) { await markCertRejected(r.application_number, r.cert_doc_id); rejected++; }
          else { const o = parseReexamOutcome(r.cert_text); await setConclusionOutcome(r.application_number, o, null); reparsed++; if (o) parsedOut++; }
          if (remainMs() < 1500) break;
        }
      }

      // Phase 2 — OCR certificates with no cached text yet. Slow (~30-40s each), so
      // a new item only starts when ~40s of budget remains; caches the text for
      // future instant re-parses. On a 429 we stop and leave the rest pending.
      while (remainMs() > 40000) {
        const todo = await getConclusionsToParse(1);
        if (!todo.length) break;
        const r = todo[0];
        try {
          const x = await detectCertificateOutcome(r.application_number, r.cert_doc_id, { allowOcr: true, downloadMs: 20000, ocrChunks: 3, ocrEngine });
          if (samples.length < 6) {
            const s = { app: r.application_number, method: x.method, textLen: x.textLen, belongs: x.belongs, parsed: !!x.outcome };
            if (req.query.debug === '1' && !samples.some((q) => q.textSample)) s.textSample = String(x.text || '').replace(/\s+/g, ' ').slice(0, 9000);
            samples.push(s);
          }
          // A certificate that cites a different proceeding (an exhibit filed under
          // the RXCERT code) is rejected: remembered and dropped, not concluded.
          if (x.belongs === false) { await markCertRejected(r.application_number, r.cert_doc_id); rejected++; }
          else { await setConclusionOutcome(r.application_number, x.outcome, x.text, ocrEngine); checked++; if (x.outcome) parsedOut++; }
        } catch (e) {
          const msg = String(e && e.message || e);
          if (/\b429\b/.test(msg) || /too many requests|rate ?limit/i.test(msg)) { rateLimited = true; pushErr(r.application_number, e); break; }
          // Mark attempted (no outcome) so a persistently-failing cert can't block
          // the queue; &retry=1 re-pools it later.
          try { await setConclusionOutcome(r.application_number, null); } catch { /* ignore */ }
          failed++; pushErr(r.application_number, e);
        }
      }
      const remaining = await countConclusionsUnparsed();
      res.status(200).json({ ok: true, mode: 'outcomes', ocrConfigured: ocrTextConfigured(), ocrEngine, repooled, reparsedFromCache: reparsed, ocrChecked: checked, parsedOutcomes: parsedOut, rejected, failed, rateLimited, errors, samples, remaining, done: remaining === 0 });
      return;
    }

    // ?grounds=1 — extract prior-art references + PTAB-trial mentions from the
    // locally-OCR'd reexam determination text (reexam_doc_text) and prior-art
    // references from PTAB FWD text (ptab_fwd.decision_text), for the reexam-vs-
    // prior-PTAB overlap analysis. Pure CPU (no USPTO calls) — fast; run until done.
    if (req.query && req.query.grounds === '1') {
      const deadline = Date.now() + budgetMs;
      let reexamDocs = 0, fwdDocs = 0;
      while (Date.now() < deadline) {
        const docs = await getDocsToExtractGrounds(100);
        if (!docs.length) break;
        for (const d of docs) {
          await setDocGrounds(d.doc_id, extractAllRefs(d.text), extractTrialNumbers(d.text));
          reexamDocs++;
        }
      }
      while (Date.now() < deadline) {
        const fwds = await getFwdsToExtractGrounds(100);
        if (!fwds.length) break;
        for (const f of fwds) {
          await setFwdGrounds(f.trial_number, extractAllRefs(f.decision_text));
          fwdDocs++;
        }
      }
      const remaining = (await countDocsToExtractGrounds()) + (await countFwdsToExtractGrounds());
      res.status(200).json({ ok: true, mode: 'grounds', reexamDocs, fwdDocs, remaining, done: remaining === 0 });
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
        // Per-series (DA-4): include 96/ supplemental-exam-resulting EPRs, matching
        // the daily enumeration. retry404 so a transient 404 can't truncate (DA-3).
        for (const prefix of ['90', '96']) {
          let offset = 0;
          for (let page = 0; page < 40 && Date.now() < deadline; page++) {
            const data = await searchApplications({
              q: `applicationNumberText:${prefix}*`,
              rangeFilters: [{ field: 'applicationMetaData.filingDate', valueFrom: from, valueTo: '2100-01-01' }],
              fields: ['applicationNumberText', 'applicationMetaData.filingDate'],
              pagination: { offset, limit: 100 },
            }, 12000, { retry404: 1 });
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
            const detDocs = docs.filter((d) => determinationLabel(d.documentCode)); // case-normalized (DA-12)
            if (detDocs.length) {
              const meta = await fetchMetaData(row.application_number).catch(() => ({}));
              for (const d of detDocs) {
                const isNew = await recordDetermination({
                  applicationNumber: row.application_number, documentIdentifier: d.documentIdentifier,
                  code: d.documentCode, type: determinationLabel(d.documentCode), officialDate: d.officialDate,
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
    res.status(500).json({ error: 'Backfill failed.', detail: clientErrorDetail(err) });
  }
}
