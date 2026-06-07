// Daily subscriber notification: emails every subscriber the list of ex parte
// reexamination determinations issued the PREVIOUS day (Pacific time). If no
// determinations issued that day, no email is sent.
//
// Schedule this on cron-job.org for 08:00 in the America/Los_Angeles timezone
// (cron-job.org honors DST when you pick the timezone), with the CRON_SECRET via
// Authorization: Bearer <secret> or ?key=<secret>.
//
// Manual helpers (still require the secret):
//   ?date=YYYY-MM-DD   override the target day
//   ?force=1           bypass the "already sent today" idempotency guard

import {
  listDeterminationsByOfficialDate, listReexamSubscribers,
  getSubDigestDate, setSubDigestDate,
} from '../../lib/db.js';
import { sendReexamSubscriberDigest } from '../../lib/email.js';

export const config = { maxDuration: 60 };

const TZ = 'America/Los_Angeles';

// YYYY-MM-DD for a Date in a given timezone (en-CA formats as ISO date).
function ymdInTZ(d, tz) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
}

// The calendar day before "today" in the given timezone.
function previousDay(tz) {
  const today = ymdInTZ(new Date(), tz);       // e.g. 2026-06-06
  const [y, m, d] = today.split('-').map(Number);
  const anchor = new Date(Date.UTC(y, m - 1, d));
  anchor.setUTCDate(anchor.getUTCDate() - 1);
  return anchor.toISOString().slice(0, 10);
}

// Human-friendly date label, e.g. "June 5, 2026".
function prettyDate(ymd) {
  const [y, m, d] = String(ymd).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', {
    timeZone: 'UTC', year: 'numeric', month: 'long', day: 'numeric',
  });
}

function baseUrl(req) {
  if (process.env.APP_BASE_URL) return process.env.APP_BASE_URL.replace(/\/$/, '');
  const host = process.env.VERCEL_PROJECT_PRODUCTION_URL || (req && req.headers && req.headers.host);
  return host ? `https://${host}` : '';
}

export default async function handler(req, res) {
  const secret = (process.env.CRON_SECRET || '').trim();
  const provided = ((req.headers.authorization || '').replace(/^Bearer\s+/i, '')
    || (req.query && req.query.key) || '').trim();
  if (secret && provided !== secret) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  try {
    const targetDate = (req.query && req.query.date) ? String(req.query.date) : previousDay(TZ);
    const force = req.query && req.query.force === '1';

    // Idempotency: don't re-send the same day's digest.
    const lastSent = await getSubDigestDate();
    if (!force && lastSent === targetDate) {
      res.status(200).json({ ok: true, date: targetDate, skipped: 'already sent for this date' });
      return;
    }

    const determinations = await listDeterminationsByOfficialDate(targetDate);
    if (!determinations.length) {
      res.status(200).json({ ok: true, date: targetDate, determinations: 0, sent: 0, note: 'No determinations issued; no email sent.' });
      return;
    }

    const subscribers = await listReexamSubscribers();
    const base = baseUrl(req);
    const dateLabel = prettyDate(targetDate);

    let sent = 0;
    const errors = [];
    for (const s of subscribers) {
      const unsubscribeUrl = `${base}/api/reexam-unsubscribe?token=${encodeURIComponent(s.token)}`;
      const r = await sendReexamSubscriberDigest(s.email, determinations, { dateLabel, unsubscribeUrl });
      if (r && r.sent) sent++;
      else if (r && (r.error || r.skipped)) errors.push({ email: s.email, reason: r.error || r.reason });
    }

    await setSubDigestDate(targetDate);

    res.status(200).json({
      ok: true,
      date: targetDate,
      determinations: determinations.length,
      subscribers: subscribers.length,
      sent,
      errors,
    });
  } catch (err) {
    res.status(500).json({ error: 'Daily reexam email failed.', detail: String(err.message || err) });
  }
}
