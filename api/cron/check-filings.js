// Daily job: for every tracked application, pull its current documents and
// record anything not seen before (flagged is_new = true). Vercel triggers this
// via the "crons" entry in vercel.json and sends `Authorization: Bearer <CRON_SECRET>`.

import { listWatched, syncApplication } from '../../lib/db.js';
import { sendDigest } from '../../lib/email.js';

export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.authorization || '';

  // If CRON_SECRET is set, require it. (Before you set it, the route still works
  // so you can test — but set it in production so only Vercel can trigger this.)
  if (secret && auth !== `Bearer ${secret}`) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  try {
    const watched = await listWatched();
    const results = [];
    const newDocs = [];
    let totalNew = 0;

    for (const w of watched) {
      try {
        const r = await syncApplication(w.application_number, true);
        totalNew += r.added;
        newDocs.push(...r.addedDocs);
        results.push({ application: w.application_number, total: r.total, added: r.added });
      } catch (e) {
        results.push({ application: w.application_number, error: String(e.message || e) });
      }
    }

    // Email a digest if there's anything new (no-op if email env vars aren't set).
    let email = { skipped: true };
    if (newDocs.length) {
      try { email = await sendDigest(newDocs); }
      catch (e) { email = { error: String(e.message || e) }; }
    }

    res.status(200).json({ ok: true, checked: watched.length, totalNew, email, results });
  } catch (err) {
    res.status(500).json({ error: 'Cron run failed.', detail: String(err.message || err) });
  }
}
