// Daily job: for every tracked application, pull its current documents and
// record anything not seen before (flagged is_new = true). Vercel triggers this
// via the "crons" entry in vercel.json and sends `Authorization: Bearer <CRON_SECRET>`.
//
// Email behavior:
//   - New filings → grouped by each application's recipient set; one email per
//     recipient set covering all their applications. Applications with NO
//     recipients listed send nothing.
//   - A daily "no new filings today" summary (listing applications with nothing
//     new) goes to DIGEST_TO.

import { listWatched, syncApplication } from '../../lib/db.js';
import { sendDigestTo, sendNoNewSummary, parseRecipients } from '../../lib/email.js';

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
    const noNewApps = [];          // applications with zero new filings (for the summary)
    const groups = new Map();      // recipientSetKey -> { recipients: [...], docs: [...] }
    let totalNew = 0;

    for (const w of watched) {
      try {
        const r = await syncApplication(w.application_number, true);
        totalNew += r.added;
        results.push({ application: w.application_number, total: r.total, added: r.added });

        if (r.added > 0) {
          const recipients = parseRecipients(w.recipients);
          if (recipients.length) {
            // Group by the exact recipient set so shared recipients get one email.
            const key = recipients.map((e) => e.toLowerCase()).sort().join(',');
            if (!groups.has(key)) groups.set(key, { recipients, docs: [] });
            groups.get(key).docs.push(...r.addedDocs);
          }
          // No recipients listed → send nothing for this application.
        } else {
          noNewApps.push({ application_number: w.application_number, label: w.label });
        }
      } catch (e) {
        results.push({ application: w.application_number, error: String(e.message || e) });
      }
    }

    // Send one digest per recipient set.
    const emails = [];
    for (const g of groups.values()) {
      try { emails.push(await sendDigestTo(g.recipients, g.docs)); }
      catch (e) { emails.push({ error: String(e.message || e) }); }
    }

    // Daily "no new filings" summary to DIGEST_TO.
    let summary;
    try { summary = await sendNoNewSummary(noNewApps, watched.length); }
    catch (e) { summary = { error: String(e.message || e) }; }

    res.status(200).json({
      ok: true,
      checked: watched.length,
      totalNew,
      emailsSent: emails.length,
      emails,
      summary,
      results,
    });
  } catch (err) {
    res.status(500).json({ error: 'Cron run failed.', detail: String(err.message || err) });
  }
}
