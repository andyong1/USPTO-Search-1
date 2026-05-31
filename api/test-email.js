// Sends a one-off test email to the configured DIGEST_TO so you can verify Resend
// without waiting for the daily cron.  POST /api/test-email
import { sendTest } from '../lib/email.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed. Use POST.' });
    return;
  }
  try {
    const result = await sendTest();
    res.status(result.ok ? 200 : 400).json(result);
  } catch (err) {
    res.status(502).json({ ok: false, reason: String(err.message || err) });
  }
}
