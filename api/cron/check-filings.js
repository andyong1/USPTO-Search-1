// Recurring job: for every tracked application, pull its current documents and
// record anything not seen before (flagged is_new = true). Triggered by an
// external scheduler (cron-job.org) via an HTTP GET with
// `Authorization: Bearer <CRON_SECRET>`. See the README for setup.
//
// Email behavior:
//   - New filings → grouped by each application's recipient set; one email per
//     recipient set covering all their applications. Applications with NO
//     recipients listed send nothing.
//   - No email is sent when there are no new filings.

import { listWatched, syncApplication } from '../../lib/db.js';
import { sendDigestTo, parseRecipients } from '../../lib/email.js';

export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.authorization || '';

  // If CRON_SECRET is set, require it so only your scheduler can trigger this.
  if (secret && auth !== `Bearer ${secret}`) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  try {
    const watched = await listWatched();
    const results = [];
    const groups = new Map(); // recipientSetKey -> { recipients: [...], docs: [...] }
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
        }
      } catch (e) {
        results.push({ application: w.application_number, error: String(e.message || e) });
      }
    }

    // Send one digest per recipient set. No email when there's nothing new.
    const emails = [];
    for (const g of groups.values()) {
      try { emails.push(await sendDigestTo(g.recipients, g.docs)); }
      catch (e) { emails.push({ error: String(e.message || e) }); }
    }

    res.status(200).json({
      ok: true,
      checked: watched.length,
      totalNew,
      emailsSent: emails.length,
      emails,
      results,
    });
  } catch (err) {
    res.status(500).json({ error: 'Cron run failed.', detail: String(err.message || err) });
  }
}
