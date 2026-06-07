// Subscribe an email address to daily ex parte reexamination determination alerts.
//   POST /api/reexam-subscribe  { email }
import { addReexamSubscriber } from '../lib/db.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed. Use POST.' });
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

    const result = await addReexamSubscriber(email);
    res.status(200).json({
      ok: true,
      existed: result.existed,
      message: result.existed
        ? 'This address is already subscribed.'
        : 'Subscribed. You will receive an email the morning after any new determinations issue.',
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: 'Could not subscribe.', detail: String(err.message || err) });
  }
}
