// PTAB FWD tracker API (read + metadata scan + classify pass + PDF proxy) — one
// function to stay within the Vercel Hobby 12-function limit.
//   GET /api/ptab                 → { rows, summary, classifierVersion }
//   GET /api/ptab?file=<url>      → stream an FWD PDF (proxied with the API key;
//                                   only api.uspto.gov ptab-files URLs; ?dl=1 to download, ?name= filename)
//   GET /api/ptab?scan=1          → metadata catalog: discover/refresh FWD rows (does NOT classify).
//                                   CRON_SECRET-gated. Params: from (2024-01-01), to, types (IPR,PGR,CBM). Resumable via ?offset=.
//   GET /api/ptab?classify=1      → classify pass: fetch each unclassified FWD PDF, extract text, classify.
//                                   CRON_SECRET-gated. Time-bounded + resumable — re-run while done=false.
import { listPtabFwd, upsertPtabFwdMeta, getPtabFwdToClassify, countPtabFwdToClassify, setPtabFwdOutcome,
  markOldFwdNoDD, getPtabFwdToCheckDD, countPtabFwdToCheckDD, setPtabFwdDD } from '../lib/db.js';
import { getApiKey } from '../lib/uspto.js';
import { fetchFwdPage, classifyFwdFromPdf, fetchDdDecision, CLASSIFIER_V, DD_CHECK_V, DD_CUTOFF } from '../lib/ptab.js';

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

    // ── Classify pass (fetch each FWD PDF, extract text, classify) ──
    if (q.classify) {
      if (!gate(req, res)) return;
      const CV = CLASSIFIER_V;
      const CONCURRENCY = 5;
      const deadline = Date.now() + 50000;
      let processed = 0; const tally = {}; const errors = [];
      while (Date.now() < deadline) {
        const batch = await getPtabFwdToClassify(CONCURRENCY, CV);
        if (!batch.length) break;
        await Promise.all(batch.map(async (row) => {
          try {
            const { outcome, detail, source } = await classifyFwdFromPdf(row.fwd_pdf_url);
            await setPtabFwdOutcome(row.trial_number, outcome, detail, source, CV);
            processed++; tally[outcome] = (tally[outcome] || 0) + 1;
          } catch (e) {
            // Mark processed (other/error) at this version so a bad PDF can't block
            // the queue; bump CLASSIFIER_V later to retry.
            try { await setPtabFwdOutcome(row.trial_number, 'other', 'classify error: ' + String(e.message || e).slice(0, 140), 'error', CV); } catch { /* ignore */ }
            processed++; tally.other = (tally.other || 0) + 1;
            if (errors.length < 5) errors.push({ trial: row.trial_number, error: String(e.message || e) });
          }
        }));
      }
      const remaining = await countPtabFwdToClassify(CV);
      res.status(200).json({ ok: true, mode: 'classify', classifierVersion: CV, processed, tally, remaining, done: remaining === 0, errors });
      return;
    }

    // ── Director discretionary decision pass (bifurcated DD process) ──
    if (q.dd) {
      if (!gate(req, res)) return;
      const V = DD_CHECK_V;
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
      res.setHeader('Cache-Control', 'private, max-age=3600');
      res.status(200).send(Buffer.from(await up.arrayBuffer()));
      return;
    }

    // ── Read (page data) ──
    res.setHeader('Cache-Control', 'no-store');
    const rows = await listPtabFwd();
    const summary = { total: rows.length, petitioner_all: 0, partial: 0, po_none: 0, other: 0, pending: 0, dd: 0, ddPending: 0 };
    for (const r of rows) {
      if ((r.classified_v || 0) < CLASSIFIER_V) summary.pending += 1;
      else summary[r.outcome] = (summary[r.outcome] || 0) + 1;
      if ((r.dd_checked_v || 0) < DD_CHECK_V) summary.ddPending += 1;
      else if (r.dd_decision && r.dd_decision !== 'none' && r.dd_decision !== 'error') summary.dd += 1;
    }
    res.status(200).json({ rows, summary, classifierVersion: CLASSIFIER_V, ddCheckVersion: DD_CHECK_V });
  } catch (err) {
    res.status(500).json({ error: 'PTAB request failed.', detail: String(err.message || err) });
  }
}
