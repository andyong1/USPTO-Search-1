// Read API for the PTAB FWD tracker page.
//   GET /api/ptab                 → { rows: [...], summary: {petitioner_all, partial, po_none, other, total} }
//   GET /api/ptab?file=<url>      → stream a Final Written Decision PDF (proxied with the API key;
//                                   only api.uspto.gov ptab-files URLs are allowed)
import { listPtabFwd } from '../lib/db.js';
import { getApiKey } from '../lib/uspto.js';

export default async function handler(req, res) {
  try {
    // FWD PDF proxy (the fileDownloadURI needs the server-held X-API-KEY).
    if (req.query && req.query.file) {
      const url = String(req.query.file);
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

    res.setHeader('Cache-Control', 'no-store');
    const rows = await listPtabFwd();
    const summary = rows.reduce((a, r) => { a.total += 1; a[r.outcome] = (a[r.outcome] || 0) + 1; return a; },
      { total: 0, petitioner_all: 0, partial: 0, po_none: 0, other: 0 });
    res.status(200).json({ rows, summary });
  } catch (err) {
    res.status(500).json({ error: 'PTAB load failed.', detail: String(err.message || err) });
  }
}
