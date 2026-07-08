// Populate the PTAB FWD tracker: fetch Final Written Decisions from the ODP
// "Search Decisions" endpoint, classify each (petitioner-all / partial / po-none
// / other) from the Board's caption, and upsert into ptab_fwd. Resumable.
//
// Trigger (Bearer <CRON_SECRET> or ?key=<CRON_SECRET>):
//   /api/cron/ptab-scan                         → IPR,PGR,CBM since 2024-01-01
//   /api/cron/ptab-scan?from=2025-01-01         → override the start date
//   /api/cron/ptab-scan?types=IPR               → limit trial types
//   /api/cron/ptab-scan?offset=500              → resume (use the nextOffset from the prior run)
// Re-run while `done` is false.

import { fetchFwdPage } from '../../lib/ptab.js';
import { upsertPtabFwd } from '../../lib/db.js';

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  const secret = (process.env.CRON_SECRET || '').trim();
  const provided = ((req.headers.authorization || '').replace(/^Bearer\s+/i, '') || (req.query && req.query.key) || '').trim();
  if (secret && provided !== secret) { res.status(401).json({ error: 'Unauthorized' }); return; }

  try {
    const types = String((req.query && req.query.types) || 'IPR,PGR,CBM').split(',').map((s) => s.trim()).filter(Boolean);
    const from = String((req.query && req.query.from) || '2024-01-01');
    const to = String((req.query && req.query.to) || '2100-01-01');
    let offset = parseInt((req.query && req.query.offset) || '0', 10) || 0;

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
      if (page.fetched < LIMIT) { done = true; break; } // last page
    }

    res.status(200).json({ ok: true, from, to, types, reportedTotal: count, fetched, upserted, nextOffset: done ? null : offset, done, errors });
  } catch (err) {
    res.status(500).json({ error: 'PTAB scan failed.', detail: String(err.message || err) });
  }
}
