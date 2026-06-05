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

// Give the job more time than the default (in case of many tracked applications).
export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  // Accept the secret from the Authorization header (with or without "Bearer ")
  // or from a ?key= query param. Whitespace is trimmed. Enforced only if set.
  const secret = (process.env.CRON_SECRET || '').trim();
  const provided = ((req.headers.authorization || '').replace(/^Bearer\s+/i, '')
    || (req.query && req.query.key) || '').trim();
  if (secret && provided !== secret) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  try {
    const watched = await listWatched();
    const results = [];
    const groups = new Map(); // recipientSetKey -> { recipients: [...], docs: [...] }
    let totalNew = 0;

    // Check applications with limited concurrency so total time is bounded by the
    // slowest application rather than the sum of all of them.
    const CONCURRENCY = 5;
    const checked = [];
    for (let i = 0; i < watched.length; i += CONCURRENCY) {
      const chunk = watched.slice(i, i + CONCURRENCY).map(async (w) => {
        try { return { w, r: await syncApplication(w.application_number, true) }; }
        catch (e) { return { w, error: String(e.message || e) }; }
      });
      checked.push(...await Promise.all(chunk));
    }

    for (const { w, r, error } of checked) {
      if (error) { results.push({ application: w.application_number, error }); continue; }
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
