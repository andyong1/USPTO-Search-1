// Send a one-off TEST of the daily reexam-determination notification to an
// address, so you can verify formatting and deliverability without waiting for
// the cron.  POST /api/reexam-test-email  { email }
//
// The test uses the most recent determinations on file (clearly labeled as a
// test) and does NOT subscribe the address.
import { listRecentDeterminations, getReexamSubscriber } from '../lib/db.js';
import { sendReexamSubscriberDigest } from '../lib/email.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function baseUrl(req) {
  if (process.env.APP_BASE_URL) return process.env.APP_BASE_URL.replace(/\/$/, '');
  const host = process.env.VERCEL_PROJECT_PRODUCTION_URL || (req && req.headers && req.headers.host);
  return host ? `https://${host}` : '';
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'Method not allowed. Use POST.' });
    return;
  }
  try {
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
    body = body || {};

    const email = String(body.email || '').trim();
    if (!EMAIL_RE.test(email)) {
      res.status(400).json({ ok: false, error: 'Please enter a valid email address.' });
      return;
    }

    const determinations = await listRecentDeterminations(15);
    const existing = await getReexamSubscriber(email);
    const token = existing ? existing.token : 'preview';
    const unsubscribeUrl = `${baseUrl(req)}/api/reexam-unsubscribe?token=${encodeURIComponent(token)}`;

    const result = await sendReexamSubscriberDigest(email, determinations, { isTest: true, unsubscribeUrl });

    if (result.error) { res.status(502).json({ ok: false, error: result.error }); return; }
    if (result.skipped) { res.status(400).json({ ok: false, error: result.reason }); return; }
    res.status(200).json({ ok: true, to: result.to, count: determinations.length });
  } catch (err) {
    res.status(500).json({ ok: false, error: 'Could not send test email.', detail: String(err.message || err) });
  }
}
