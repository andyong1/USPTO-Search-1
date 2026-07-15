// PTAB FWD tracker API (read + metadata scan + classify pass + PDF proxy) — one
// function to stay within the Vercel Hobby 12-function limit.
//   GET /api/ptab                 → { rows, summary, classifierVersion }
//   GET /api/ptab?file=<url>      → stream an FWD PDF (proxied with the API key;
//                                   only api.uspto.gov ptab-files URLs; ?dl=1 to download, ?name= filename)
//   GET /api/ptab?scan=1          → metadata catalog: discover/refresh FWD rows (does NOT classify).
//                                   CRON_SECRET-gated. Params: from (2024-01-01), to, types (IPR,PGR,CBM). Resumable via ?offset=.
//   GET /api/ptab?extract=1       → extract pass: fetch each FWD PDF, extract + STORE its text (expensive; run once).
//                                   CRON_SECRET-gated. Time-bounded + resumable — re-run while done=false.
//                                   Add &trial=<no> to force a re-extract + reclassify of one proceeding (diagnostic).
//   GET /api/ptab?classify=1      → classify pass: run the classifier over the STORED text (offline, no fetch).
//                                   CRON_SECRET-gated. Bump CLASSIFIER_V + re-run to reclassify without re-fetching.
//   GET /api/ptab?dd=1            → director-discretionary-decision backfill (CRON_SECRET-gated, resumable).
//                                   Add &trial=<no> to force a re-check of a single proceeding.
//   GET /api/ptab?dscan=1&feed=inst|dd → decisions catalog for /ptab-decisions (institution + DD
//                                   decisions since 2024; metadata-only). CRON_SECRET-gated, resumable via ?offset=.
//   GET /api/ptab?decisions=1     → read for the /ptab-decisions page ({ rows, summary }).
//   GET /api/ptab?fscan=1         → filings-trends scan: DAILY counts of ex parte reexams + IPR
//                                   petitions since 2024 (CRON_SECRET-gated, concurrent, resumable).
//   GET /api/ptab?filings=1       → read for the /filings-trends page ({ reexam:[], ipr:[], updatedAt }).
//   GET /api/ptab?compare=1       → EPR-vs-IPR head-to-head aggregates + IPR→reexam patent linkage
//                                   (joins reexam underlying_patent to ptab_decisions/ptab_fwd patent_number).
//   GET /api/ptab?maintain=1      → one-shot orchestrator: scan→extract→classify→dd, bounded to ~22s for a
//                                   single external scheduler (cron-job.org). CRON_SECRET-gated; resumable (done flag).
import { listPtabFwd, upsertPtabFwdMeta, getPtabFwdToExtract, countPtabFwdToExtract, setPtabFwdText,
  getPtabFwdToClassify, countPtabFwdToClassify, setPtabFwdOutcome,
  markOldFwdNoDD, getPtabFwdToCheckDD, countPtabFwdToCheckDD, setPtabFwdDD, getPtabFwdByTrial,
  stampMaintainRun, getMaintainLastRun,
  upsertPtabInstitution, upsertPtabDd, listPtabDecisions, upsertFilingCount, listFilings,
  listRecentDeterminations, listPtabFwdBrief } from '../lib/db.js';
import { getApiKey } from '../lib/uspto.js';
import { fetchFwdPage, extractFwdText, classifyFwd, fetchDdDecision, detectDdDecision, fetchTrialDetail,
  fetchInstitutionPage, fetchDdPage, fetchReexamFilingCount, fetchIprPetitionCount, CLASSIFIER_V, EXTRACT_V, DD_CHECK_V, DD_CUTOFF } from '../lib/ptab.js';

export const config = { maxDuration: 60 };

function gate(req, res) {
  const secret = (process.env.CRON_SECRET || '').trim();
  const provided = ((req.headers.authorization || '').replace(/^Bearer\s+/i, '') || (req.query && req.query.key) || '').trim();
  if (secret && provided !== secret) { res.status(401).json({ error: 'Unauthorized' }); return false; }
  return true;
}

export default async function handler(req, res) {
  try {
    const q = req.query || {};

    // ── Metadata catalog (discover/refresh FWD rows; no classification) ──
    if (q.scan) {
      if (!gate(req, res)) return;
      const types = String(q.types || 'IPR,PGR,CBM').split(',').map((s) => s.trim()).filter(Boolean);
      const from = String(q.from || '2024-01-01');
      const to = String(q.to || '2100-01-01');
      let offset = parseInt(q.offset || '0', 10) || 0;
      const LIMIT = 100, MAX_PAGES = 5;
      const deadline = Date.now() + 50000;
      let pages = 0, fetched = 0, upserted = 0, count = null, done = false;
      const errors = [];
      while (pages < MAX_PAGES && Date.now() < deadline) {
        let page;
        try { page = await fetchFwdPage({ types, from, to, offset, limit: LIMIT }); }
        catch (e) { errors.push({ offset, error: String(e.message || e) }); break; }
        count = page.count; fetched += page.fetched;
        for (const r of page.rows) { try { await upsertPtabFwdMeta(r); upserted++; } catch (e) { errors.push({ trial: r.trial_number, error: String(e.message || e) }); } }
        pages++; offset += LIMIT;
        if (page.fetched < LIMIT) { done = true; break; }
      }
      res.status(200).json({ ok: true, mode: 'catalog', from, to, types, reportedTotal: count, fetched, upserted, nextOffset: done ? null : offset, done, errors });
      return;
    }

    // ── Decisions catalog (institution + Director-discretionary decisions) ──
    // Metadata-only (no PDFs). ?feed=inst|dd, resumable via ?offset=.
    if (q.dscan) {
      if (!gate(req, res)) return;
      const feed = String(q.feed || 'inst') === 'dd' ? 'dd' : 'inst';
      const from = String(q.from || '2024-01-01');
      const to = String(q.to || '2100-01-01');
      let offset = parseInt(q.offset || '0', 10) || 0;
      const LIMIT = 100, MAX_PAGES = 6;
      const deadline = Date.now() + 50000;
      let pages = 0, fetched = 0, upserted = 0, count = null, done = false;
      const errors = [];
      while (pages < MAX_PAGES && Date.now() < deadline) {
        let page;
        try { page = feed === 'dd' ? await fetchDdPage({ from, to, offset, limit: LIMIT }) : await fetchInstitutionPage({ from, to, offset, limit: LIMIT }); }
        catch (e) { errors.push({ offset, error: String(e.message || e) }); break; }
        count = page.count; fetched += page.fetched;
        for (const r of page.rows) {
          try { if (feed === 'dd') await upsertPtabDd(r); else await upsertPtabInstitution(r); upserted++; }
          catch (e) { errors.push({ trial: r.trial_number, error: String(e.message || e) }); }
        }
        pages++; offset += LIMIT;
        if (page.fetched < LIMIT) { done = true; break; }
      }
      res.status(200).json({ ok: true, mode: 'dscan', feed, from, to, reportedTotal: count, fetched, upserted, nextOffset: done ? null : offset, done, errors });
      return;
    }

    // ── Extract pass (fetch each FWD PDF, extract + store its text) ──
    // Expensive (network + PDF parse). Run once; text is cached so classification
    // can be re-run offline. Bump EXTRACT_V (and re-run) only if extraction changes.
    if (q.extract) {
      if (!gate(req, res)) return;
      const EV = EXTRACT_V;
      // Targeted re-extract + reclassify of one trial (forces past the version gate).
      // Diagnostic: reports the text source, length, and resulting outcome.
      if (q.trial) {
        const trial = String(q.trial).toUpperCase().trim();
        if (!/^[A-Z]{2,4}\d{4}-\d{5}$/.test(trial)) { res.status(400).json({ error: 'Invalid trial number.' }); return; }
        const row = await getPtabFwdByTrial(trial);
        if (!row || !row.fwd_pdf_url) { res.status(404).json({ error: 'No FWD PDF on file for this trial.' }); return; }
        try {
          const { text, source } = await extractFwdText(row.fwd_pdf_url);
          await setPtabFwdText(trial, text, source, EV);
          const { outcome, detail } = classifyFwd(text);
          await setPtabFwdOutcome(trial, outcome, detail, CLASSIFIER_V);
          res.status(200).json({ ok: true, mode: 'extract', trial, source, textLength: (text || '').length, outcome, detail });
        } catch (e) { res.status(502).json({ error: 'Extract failed.', detail: String(e.message || e) }); }
        return;
      }
      const CONCURRENCY = 5;
      const deadline = Date.now() + 50000;
      let processed = 0; const tally = {}; const errors = [];
      while (Date.now() < deadline) {
        const batch = await getPtabFwdToExtract(CONCURRENCY, EV);
        if (!batch.length) break;
        await Promise.all(batch.map(async (row) => {
          try {
            const { text, source } = await extractFwdText(row.fwd_pdf_url);
            await setPtabFwdText(row.trial_number, text, source, EV);
            processed++; tally[source] = (tally[source] || 0) + 1;
          } catch (e) {
            // Store an empty/error row at this version so a bad PDF can't block the
            // queue; bump EXTRACT_V later to retry.
            try { await setPtabFwdText(row.trial_number, '', 'error', EV); } catch { /* ignore */ }
            processed++; tally.error = (tally.error || 0) + 1;
            if (errors.length < 5) errors.push({ trial: row.trial_number, error: String(e.message || e) });
          }
        }));
      }
      const remaining = await countPtabFwdToExtract(EV);
      res.status(200).json({ ok: true, mode: 'extract', extractVersion: EV, processed, tally, remaining, done: remaining === 0, errors });
      return;
    }

    // ── Classify pass (offline: run the classifier over the stored text) ──
    // Cheap and network-free, so a CLASSIFIER_V bump reprocesses everything without
    // re-fetching a single PDF. Only rows that have been extracted are eligible.
    if (q.classify) {
      if (!gate(req, res)) return;
      const CV = CLASSIFIER_V;
      const BATCH = 150;
      const deadline = Date.now() + 50000;
      let processed = 0; const tally = {};
      while (Date.now() < deadline) {
        const batch = await getPtabFwdToClassify(BATCH, CV);
        if (!batch.length) break;
        for (const row of batch) {
          const { outcome, detail } = classifyFwd(row.decision_text || '');
          await setPtabFwdOutcome(row.trial_number, outcome, detail, CV);
          processed++; tally[outcome] = (tally[outcome] || 0) + 1;
        }
      }
      const remaining = await countPtabFwdToClassify(CV);
      res.status(200).json({ ok: true, mode: 'classify', classifierVersion: CV, processed, tally, remaining, done: remaining === 0 });
      return;
    }

    // ── Director discretionary decision pass (bifurcated DD process) ──
    if (q.dd) {
      if (!gate(req, res)) return;
      const V = DD_CHECK_V;
      // Targeted re-check of one trial (forces past the version/cutoff gate) — for
      // fixing a single row without re-running the whole set, and because a DD
      // decision can be filed after the initial check.
      if (q.trial) {
        const trial = String(q.trial).toUpperCase().trim();
        if (!/^[A-Z]{2,4}\d{4}-\d{5}$/.test(trial)) { res.status(400).json({ error: 'Invalid trial number.' }); return; }
        try { const dd = await fetchDdDecision(trial); await setPtabFwdDD(trial, dd, V); res.status(200).json({ ok: true, mode: 'dd', trial, dd_decision: dd, ddCheckVersion: V }); }
        catch (e) { res.status(502).json({ error: 'DD check failed.', detail: String(e.message || e) }); }
        return;
      }
      const markedOld = await markOldFwdNoDD(V, DD_CUTOFF); // pre-DD-process FWDs → 'none' (no fetch)
      const CONCURRENCY = 5;
      const deadline = Date.now() + 50000;
      let processed = 0; const tally = {}; const errors = [];
      while (Date.now() < deadline) {
        const batch = await getPtabFwdToCheckDD(CONCURRENCY, V, DD_CUTOFF);
        if (!batch.length) break;
        await Promise.all(batch.map(async (trial) => {
          try { const dd = await fetchDdDecision(trial); await setPtabFwdDD(trial, dd, V); processed++; tally[dd] = (tally[dd] || 0) + 1; }
          catch (e) {
            try { await setPtabFwdDD(trial, 'error', V); } catch { /* ignore */ }
            processed++; tally.error = (tally.error || 0) + 1;
            if (errors.length < 5) errors.push({ trial, error: String(e.message || e) });
          }
        }));
      }
      const remaining = await countPtabFwdToCheckDD(V, DD_CUTOFF);
      res.status(200).json({ ok: true, mode: 'dd', ddCheckVersion: V, markedOld, processed, tally, remaining, done: remaining === 0, errors });
      return;
    }

    // ── Maintenance orchestrator (one-shot: scan → extract → classify → dd) ──
    // For a single external scheduler (e.g. cron-job.org) that can't loop. Bounded
    // to ~22s to return inside cron-job.org's 30s timeout. Resumable: returns
    // done=false with per-pass remaining counts if a heavy backlog doesn't fit.
    if (q.maintain) {
      if (!gate(req, res)) return;
      const CV = CLASSIFIER_V, EV = EXTRACT_V, DDV = DD_CHECK_V;
      const deadline = Date.now() + 22000;
      const out = { ok: true, mode: 'maintain' };

      // 1) Scan the newest FWDs (2 pages = 200 newest; new decisions sort to the top).
      try {
        let offset = 0, upserted = 0, reportedTotal = null;
        for (let p = 0; p < 2 && Date.now() < deadline; p++) {
          const page = await fetchFwdPage({ types: ['IPR', 'PGR', 'CBM'], from: '2024-01-01', to: '2100-01-01', offset, limit: 100 });
          reportedTotal = page.count;
          for (const r of page.rows) { try { await upsertPtabFwdMeta(r); upserted++; } catch { /* skip bad row */ } }
          offset += 100;
          if (page.fetched < 100) break;
        }
        out.scan = { upserted, reportedTotal };
      } catch (e) { out.scan = { error: String(e.message || e) }; }

      // 2) Extract pending FWD PDFs (bounded by the shared deadline).
      let exProc = 0; const exTally = {};
      while (Date.now() < deadline) {
        const batch = await getPtabFwdToExtract(5, EV);
        if (!batch.length) break;
        await Promise.all(batch.map(async (row) => {
          try { const { text, source } = await extractFwdText(row.fwd_pdf_url); await setPtabFwdText(row.trial_number, text, source, EV); exProc++; exTally[source] = (exTally[source] || 0) + 1; }
          catch { try { await setPtabFwdText(row.trial_number, '', 'error', EV); } catch { /* ignore */ } exProc++; exTally.error = (exTally.error || 0) + 1; }
        }));
      }
      out.extract = { processed: exProc, tally: exTally };

      // 3) Classify pending (offline; fast).
      let clProc = 0; const clTally = {};
      while (Date.now() < deadline) {
        const batch = await getPtabFwdToClassify(150, CV);
        if (!batch.length) break;
        for (const row of batch) { const { outcome, detail } = classifyFwd(row.decision_text || ''); await setPtabFwdOutcome(row.trial_number, outcome, detail, CV); clProc++; clTally[outcome] = (clTally[outcome] || 0) + 1; }
      }
      out.classify = { processed: clProc, tally: clTally };

      // 4) Director discretionary decision backfill (bounded).
      const markedOld = await markOldFwdNoDD(DDV, DD_CUTOFF);
      let ddProc = 0; const ddTally = {};
      while (Date.now() < deadline) {
        const batch = await getPtabFwdToCheckDD(5, DDV, DD_CUTOFF);
        if (!batch.length) break;
        await Promise.all(batch.map(async (trial) => {
          try { const dd = await fetchDdDecision(trial); await setPtabFwdDD(trial, dd, DDV); ddProc++; ddTally[dd] = (ddTally[dd] || 0) + 1; }
          catch { try { await setPtabFwdDD(trial, 'error', DDV); } catch { /* ignore */ } ddProc++; ddTally.error = (ddTally.error || 0) + 1; }
        }));
      }
      out.dd = { markedOld, processed: ddProc, tally: ddTally };

      // 5) Refresh the newest institution + Director-discretionary decisions
      // (metadata-only; newest-first so new decisions are caught within a day).
      let decProc = 0;
      try {
        for (const feed of ['inst', 'dd']) {
          for (let p = 0; p < 2 && Date.now() < deadline; p++) {
            const page = feed === 'dd' ? await fetchDdPage({ offset: p * 100, limit: 100 }) : await fetchInstitutionPage({ offset: p * 100, limit: 100 });
            for (const r of page.rows) { try { if (feed === 'dd') await upsertPtabDd(r); else await upsertPtabInstitution(r); decProc++; } catch { /* skip */ } }
            if (page.fetched < 100) break;
          }
        }
      } catch { /* best-effort */ }
      out.decisions = { upserted: decProc };

      const [remExtract, remClassify, remDd] = await Promise.all([
        countPtabFwdToExtract(EV), countPtabFwdToClassify(CV), countPtabFwdToCheckDD(DDV, DD_CUTOFF),
      ]);
      out.remaining = { extract: remExtract, classify: remClassify, dd: remDd };
      out.done = remExtract === 0 && remClassify === 0 && remDd === 0;
      try { await stampMaintainRun(); } catch { /* heartbeat is best-effort */ }
      res.status(200).json(out);
      return;
    }

    // ── Trial detail (live docket + status for one proceeding) ──
    if (q.trial) {
      const trial = String(q.trial).toUpperCase().trim();
      if (!/^[A-Z]{2,4}\d{4}-\d{5}$/.test(trial)) { res.status(400).json({ error: 'Invalid trial number.' }); return; }
      let detail;
      try { detail = await fetchTrialDetail(trial); }
      catch (e) { res.status(502).json({ error: 'Trial fetch failed.', detail: String(e.message || e) }); return; }
      let stored = null;
      try {
        const s = await getPtabFwdByTrial(trial);
        // Include the catalog metadata too, so the page can render a header even
        // when the live docket is unavailable (404).
        if (s) stored = {
          outcome: s.outcome, outcome_detail: s.outcome_detail, dd_decision: s.dd_decision,
          classified_v: s.classified_v, dd_checked_v: s.dd_checked_v, fwd_date: s.fwd_date, fwd_pdf_url: s.fwd_pdf_url,
          trial_type: s.trial_type, patent_number: s.patent_number, application_number: s.application_number,
          tech_center: s.tech_center, group_art_unit: s.group_art_unit, po_name: s.po_name, petitioner_name: s.petitioner_name,
          po_counsel: s.po_counsel, petitioner_counsel: s.petitioner_counsel, petition_date: s.petition_date, institution_date: s.institution_date,
        };
      } catch { /* stored FWD data is optional enrichment */ }
      // Self-heal the DD flag from the docket we just fetched: the standalone dd
      // check hits the same feed but can be rate-limited into failing, whereas this
      // fetch already succeeded. Only persist a positive detection (never downgrade
      // to 'none' from a possibly-partial docket), so the table badge self-corrects.
      try {
        if (!detail.docsUnavailable && detail.documents.length) {
          const dd = detectDdDecision(detail.documents.map((d) => ({ typeDesc: d.type, title: d.title })));
          if (dd && dd !== 'none' && dd !== 'error' && (!stored || stored.dd_decision !== dd)) {
            await setPtabFwdDD(trial, dd, DD_CHECK_V);
            if (stored) { stored.dd_decision = dd; stored.dd_checked_v = DD_CHECK_V; }
          }
        }
      } catch { /* best-effort self-heal */ }
      res.setHeader('Cache-Control', 'private, max-age=300');
      res.status(200).json({ trial, meta: detail.meta, documents: detail.documents, count: detail.count, docsUnavailable: detail.docsUnavailable, stored, classifierVersion: CLASSIFIER_V, ddCheckVersion: DD_CHECK_V });
      return;
    }

    // ── FWD PDF proxy ──
    if (q.file) {
      const url = String(q.file);
      if (!/^https:\/\/api\.uspto\.gov\/api\/v1\/patent\/ptab-files\/[^\s]+$/.test(url)) {
        res.status(400).json({ error: 'Invalid file URL.' });
        return;
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 25000);
      let up;
      try { up = await fetch(url, { headers: { 'X-API-KEY': getApiKey() }, signal: controller.signal }); }
      catch (e) { res.status(502).json({ error: 'PDF fetch failed.', detail: controller.signal.aborted ? 'timed out' : String(e) }); return; }
      finally { clearTimeout(timer); }
      if (!up.ok) { res.status(up.status).json({ error: 'PDF not available.' }); return; }
      let fname = String(q.name || 'final-written-decision.pdf').replace(/[^A-Za-z0-9._-]/g, '') || 'final-written-decision.pdf';
      if (!/\.pdf$/i.test(fname)) fname += '.pdf';
      // Force application/pdf — the ptab-files endpoint serves a generic type
      // (octet-stream), which makes browsers download instead of rendering inline.
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `${q.dl ? 'attachment' : 'inline'}; filename="${fname}"`);
      // Decision PDFs are immutable — let the edge cache and serve repeats instead
      // of re-fetching from USPTO each time.
      res.setHeader('Cache-Control', 'public, max-age=86400');
      res.status(200).send(Buffer.from(await up.arrayBuffer()));
      return;
    }

    // ── Filings trends scan (DAILY counts: ex parte reexams + IPR petitions) ──
    // One count query per day per kind. Newest-first, concurrent, and skips days
    // already stored (a past day's count is fixed) except the most recent two, so
    // the one-time backfill drains over a few runs and steady state is tiny.
    if (q.fscan) {
      if (!gate(req, res)) return;
      const pad = (n) => String(n).padStart(2, '0');
      const dayStr = (t) => { const dt = new Date(t); return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`; };
      const START = Date.UTC(2024, 0, 1), DAY = 86400000;
      const todayMs = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate());
      const stored = new Set((await listFilings()).map((r) => r.kind + ':' + r.d));
      // Build the work list (newest day first), skipping settled stored days.
      const work = [];
      for (let t = todayMs; t >= START; t -= DAY) {
        const d = dayStr(t);
        const recent = t >= todayMs - DAY; // always refresh today + yesterday
        for (const kind of ['reexam', 'ipr']) if (recent || !stored.has(kind + ':' + d)) work.push({ kind, d });
      }
      const CONCURRENCY = 4;
      // ~22s so it returns inside cron-job.org's 30s timeout; re-run to continue.
      const deadline = Date.now() + 22000;
      let processed = 0; const errors = [];
      let i = 0;
      async function worker() {
        while (i < work.length && Date.now() < deadline) {
          const { kind, d } = work[i++];
          try {
            const count = kind === 'ipr' ? await fetchIprPetitionCount(d, d) : await fetchReexamFilingCount(d, d);
            await upsertFilingCount(kind, d, count); processed++;
          } catch (e) { if (errors.length < 6) errors.push({ kind, d, error: String(e.message || e) }); }
        }
      }
      await Promise.all(Array.from({ length: CONCURRENCY }, worker));
      const remaining = work.length - processed;
      res.status(200).json({ ok: true, mode: 'filings-scan', processed, remaining, done: remaining <= 0, errors });
      return;
    }

    // ── Filings trends read (daily series per kind) ──
    if (q.filings) {
      res.setHeader('Cache-Control', 'no-store');
      const rows = await listFilings();
      const series = { reexam: [], ipr: [] };
      let updatedAt = null;
      for (const r of rows) {
        if (series[r.kind]) series[r.kind].push({ d: r.d, count: r.count });
        if (r.updated_at && (!updatedAt || r.updated_at > updatedAt)) updatedAt = r.updated_at;
      }
      res.status(200).json({ ...series, updatedAt });
      return;
    }

    // ── EPR-vs-IPR head-to-head + IPR→reexam linkage (for /filings-trends) ──
    // Joins the reexamined patent (reexam_tech_center.underlying_patent) to PTAB
    // proceedings on the same patent (ptab_decisions + ptab_fwd). PTAB data begins
    // 2024-01-01, so links to older IPRs aren't visible (surfaced via `coverage`).
    if (q.compare) {
      res.setHeader('Cache-Control', 'no-store');
      const [dets, decisions, fwd, filings] = await Promise.all([
        listRecentDeterminations(), listPtabDecisions(), listPtabFwdBrief(), listFilings(),
      ]);
      const norm = (p) => String(p || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      const has = (x) => x != null && String(x).trim() !== '';
      const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2); };
      const days = (a, b) => { const A = Date.parse(a), B = Date.parse(b); return (isFinite(A) && isFinite(B) && B >= A) ? Math.round((B - A) / 86400000) : null; };
      const pct = (n, d) => (d ? +(n / d * 100).toFixed(1) : null);

      // Merge PTAB proceedings (institution/discretionary + FWD) by trial number.
      const trials = new Map();
      for (const d of decisions) trials.set(d.trial_number, {
        trial: d.trial_number, type: d.trial_type, patent: d.patent_number,
        petition_date: d.petition_date, institution_date: d.institution_date,
        inst_type: d.inst_type, dd_type: d.dd_type, fwd_date: null, outcome: null,
      });
      for (const f of fwd) {
        const t = trials.get(f.trial_number) || { trial: f.trial_number, type: f.trial_type, patent: f.patent_number, petition_date: f.petition_date, institution_date: f.institution_date, inst_type: null, dd_type: null };
        t.fwd_date = f.fwd_date; t.outcome = f.outcome;
        t.patent = t.patent || f.patent_number;
        t.petition_date = t.petition_date || f.petition_date;
        t.institution_date = t.institution_date || f.institution_date;
        trials.set(f.trial_number, t);
      }
      const byPatent = new Map();
      for (const t of trials.values()) { const k = norm(t.patent); if (!k) continue; if (!byPatent.has(k)) byPatent.set(k, []); byPatent.get(k).push(t); }

      // Head-to-head aggregates.
      const filingsTotals = { reexam: 0, ipr: 0 };
      for (const r of filings) if (filingsTotals[r.kind] != null) filingsTotals[r.kind] += r.count;

      let instGranted = 0, instDenied = 0, ddDeny = 0, ddRefer = 0;
      for (const d of decisions) {
        if (d.inst_type === 'granted') instGranted++; else if (d.inst_type === 'denied') instDenied++;
        if (d.dd_type === 'deny') ddDeny++; else if (d.dd_type === 'refer') ddRefer++;
      }
      const instTot = instGranted + instDenied;

      let pAll = 0, pPartial = 0, pNone = 0, pOther = 0;
      for (const f of fwd) {
        if (f.outcome === 'petitioner_all') pAll++; else if (f.outcome === 'partial') pPartial++;
        else if (f.outcome === 'po_none') pNone++; else if (f.outcome === 'other') pOther++;
      }
      const fwdClassified = pAll + pPartial + pNone + pOther;
      const iprPend = median(fwd.map((f) => days(f.petition_date, f.fwd_date)).filter((x) => x != null));

      let eprOrdered = 0, eprDenied = 0;
      for (const d of dets) { const t = String(d.determination_type || ''); if (/ordered/i.test(t)) eprOrdered++; else if (/denied/i.test(t)) eprDenied++; }
      const eprTot = eprOrdered + eprDenied;
      const parsed = dets.filter((d) => has(d.outcome_summary));
      let eprAllCancel = 0, eprAnyCancel = 0;
      for (const d of parsed) if (has(d.claims_cancelled)) { eprAnyCancel++; if (!(has(d.claims_confirmed) || has(d.claims_amended) || has(d.claims_new))) eprAllCancel++; }
      const eprPend = median(dets.map((d) => days(d.filing_date, d.cert_date)).filter((x) => x != null));

      // IPR→EPR linkage rows (one per reexam determination with a resolved patent
      // that matches ≥1 PTAB proceeding). Category = most-notable matched status.
      const rank = { ipr_denied: 0, ipr_fwd: 1, ipr_instituted: 2, ipr_other: 3 };
      const links = [];
      for (const d of dets) {
        const k = norm(d.underlying_patent); if (!k) continue;
        const iprs = byPatent.get(k); if (!iprs || !iprs.length) continue;
        const mapped = iprs.map((t) => {
          let status;
          if (t.inst_type === 'denied' || t.dd_type === 'deny' || t.dd_type === 'refer') status = 'ipr_denied';
          else if (t.fwd_date) status = 'ipr_fwd';
          else if (t.inst_type === 'granted') status = 'ipr_instituted';
          else status = 'ipr_other';
          return { trial: t.trial, type: t.type, status, inst_type: t.inst_type, dd_type: t.dd_type, outcome: t.outcome, petition_date: t.petition_date, institution_date: t.institution_date, fwd_date: t.fwd_date };
        }).sort((a, b) => rank[a.status] - rank[b.status]);
        const reexamDate = d.filing_date || d.official_date;
        const iprEarliest = mapped.map((m) => m.petition_date).filter(Boolean).sort()[0] || null;
        links.push({
          appNum: d.application_number, patent: d.underlying_patent,
          reexam_type: d.determination_type, reexam_date: d.official_date, filing_date: d.filing_date,
          requester: d.requester_type, category: mapped[0].status,
          iprFirst: (iprEarliest && reexamDate) ? iprEarliest < reexamDate : null, iprs: mapped,
        });
      }
      links.sort((a, b) => (rank[a.category] - rank[b.category]) || String(b.reexam_date || '').localeCompare(String(a.reexam_date || '')));

      let updatedAt = null;
      for (const r of filings) if (r.updated_at && (!updatedAt || r.updated_at > updatedAt)) updatedAt = r.updated_at;

      res.status(200).json({
        headToHead: {
          filings: filingsTotals,
          institution: {
            ipr: { granted: instGranted, denied: instDenied, total: instTot, pct: pct(instGranted, instTot) },
            epr: { ordered: eprOrdered, denied: eprDenied, total: eprTot, pct: pct(eprOrdered, eprTot) },
          },
          discretionary: { ipr: { deny: ddDeny, refer: ddRefer, total: decisions.length, pct: pct(ddDeny + ddRefer, decisions.length) } },
          claimCancel: {
            ipr: { allUnpatentable: pAll, classified: fwdClassified, pct: pct(pAll, fwdClassified) },
            epr: { allCancelled: eprAllCancel, anyCancelled: eprAnyCancel, parsed: parsed.length, pct: pct(eprAllCancel, parsed.length) },
          },
          pendencyDays: { ipr: iprPend, epr: eprPend },
        },
        links,
        coverage: { reexamsWithPatent: dets.filter((d) => has(d.underlying_patent)).length, reexamsTotal: dets.length, iprTrials: trials.size, linked: links.length },
        updatedAt,
      });
      return;
    }

    // ── Decisions read (discretion / institution decisions page) ──
    if (q.decisions) {
      res.setHeader('Cache-Control', 'no-store');
      const drows = await listPtabDecisions();
      const dsummary = { total: drows.length, dd_deny: 0, dd_refer: 0, inst_granted: 0, inst_denied: 0 };
      for (const r of drows) {
        if (r.dd_type === 'deny') dsummary.dd_deny++; else if (r.dd_type === 'refer') dsummary.dd_refer++;
        if (r.inst_type === 'granted') dsummary.inst_granted++; else if (r.inst_type === 'denied') dsummary.inst_denied++;
      }
      res.status(200).json({ rows: drows, summary: dsummary });
      return;
    }

    // ── Read (page data) ──
    res.setHeader('Cache-Control', 'no-store');
    const all = await listPtabFwd();
    const summary = { total: all.length, petitioner_all: 0, partial: 0, po_none: 0, other: 0, pending: 0, extractPending: 0, dd: 0, ddPending: 0 };
    let latestFwd = '';
    for (const r of all) {
      if (r.fwd_date && r.fwd_date > latestFwd) latestFwd = r.fwd_date;
      if ((r.extracted_v || 0) < EXTRACT_V) summary.extractPending += 1;
      if ((r.classified_v || 0) < CLASSIFIER_V) summary.pending += 1;
      else summary[r.outcome] = (summary[r.outcome] || 0) + 1;
      if ((r.dd_checked_v || 0) < DD_CHECK_V) summary.ddPending += 1;
      else if (r.dd_decision && r.dd_decision !== 'none' && r.dd_decision !== 'error') summary.dd += 1;
    }
    let maintainLastRun = null;
    try { maintainLastRun = await getMaintainLastRun(); } catch { /* optional */ }
    const meta = { summary, maintainLastRun, latestFwd, classifierVersion: CLASSIFIER_V, extractVersion: EXTRACT_V, ddCheckVersion: DD_CHECK_V };
    // ?summary=1 → lightweight (no rows), for the status dashboard.
    if (q.summary) { res.status(200).json(meta); return; }
    // Drop the bulky stored decision_text — the page never needs it.
    const rows = all.map(({ decision_text, ...rest }) => rest);
    res.status(200).json({ rows, ...meta });
  } catch (err) {
    res.status(500).json({ error: 'PTAB request failed.', detail: String(err.message || err) });
  }
}
