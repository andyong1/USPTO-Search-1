// PTAB FWD tracker API (read + scan + PDF proxy) — one function to stay within
// the Vercel Hobby 12-function limit.
//   GET /api/ptab                 → { rows: [...], summary: {petitioner_all, partial, po_none, other, total} }
//   GET /api/ptab?file=<url>      → stream a Final Written Decision PDF (proxied with the API key;
//                                   only api.uspto.gov ptab-files URLs are allowed)
//   GET /api/ptab?scan=1          → populate/refresh the cache from the ODP Search Decisions endpoint.
//                                   CRON_SECRET-gated (Bearer or ?key=). Resumable via ?offset=<nextOffset>.
//                                   Params: from (default 2024-01-01), to, types (default IPR,PGR,CBM). Re-run while done=false.
import { listPtabFwd, upsertPtabFwd } from '../lib/db.js';
import { getApiKey } from '../lib/uspto.js';
import { fetchFwdPage } from '../lib/ptab.js';

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  try {
    const q = req.query || {};

    // ── Scan / populate (CRON_SECRET-gated) ──
    if (q.scan) {
      const secret = (process.env.CRON_SECRET || '').trim();
      const provided = ((req.headers.authorization || '').replace(/^Bearer\s+/i, '') || q.key || '').trim();
      if (secret && provided !== secret) { res.status(401).json({ error: 'Unauthorized' }); return; }

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
        count = page.count;
        fetched += page.fetched;
        for (const r of page.rows) { try { await upsertPtabFwd(r); upserted++; } catch (e) { errors.push({ trial: r.trial_number, error: String(e.message || e) }); } }
        pages++;
        offset += LIMIT;
        if (page.fetched < LIMIT) { done = true; break; }
      }
      res.status(200).json({ ok: true, from, to, types, reportedTotal: count, fetched, upserted, nextOffset: done ? null : offset, done, errors });
      return;
    }

    // ── FWD PDF proxy (the fileDownloadURI needs the server-held X-API-KEY) ──
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
      res.setHeader('Content-Type', up.headers.get('content-type') || 'application/pdf');
      res.setHeader('Content-Disposition', 'inline');
      res.setHeader('Cache-Control', 'private, max-age=3600');
      res.status(200).send(Buffer.from(await up.arrayBuffer()));
      return;
    }

    // ── Read (page data) ──
    res.setHeader('Cache-Control', 'no-store');
    const rows = await listPtabFwd();
    const summary = rows.reduce((a, r) => { a.total += 1; a[r.outcome] = (a[r.outcome] || 0) + 1; return a; },
      { total: 0, petitioner_all: 0, partial: 0, po_none: 0, other: 0 });
    res.status(200).json({ rows, summary });
  } catch (err) {
    res.status(500).json({ error: 'PTAB request failed.', detail: String(err.message || err) });
  }
}
