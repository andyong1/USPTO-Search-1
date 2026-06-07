// Daily reexam-determination alert subscriptions (single endpoint to stay within
// the Hobby plan's serverless-function limit).
//
//   POST /api/reexam-subscribe            { email }                 → subscribe
//   POST /api/reexam-subscribe            { email, action:"test" }  → send test email
//   GET  /api/reexam-subscribe?token=...                            → unsubscribe (HTML page)
import {
  addReexamSubscriber, removeReexamSubscriberByToken, getReexamSubscriber,
  listRecentDeterminations,
} from '../lib/db.js';
import { sendReexamSubscriberDigest } from '../lib/email.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function baseUrl(req) {
  if (process.env.APP_BASE_URL) return process.env.APP_BASE_URL.replace(/\/$/, '');
  const host = process.env.VERCEL_PROJECT_PRODUCTION_URL || (req && req.headers && req.headers.host);
  return host ? `https://${host}` : '';
}

function unsubscribeUrl(req, token) {
  return `${baseUrl(req)}/api/reexam-subscribe?token=${encodeURIComponent(token)}`;
}

function page(title, message) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${title}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f0f4f8; color: #2d3748; display: flex; min-height: 100vh; align-items: center; justify-content: center; margin: 0; padding: 24px; }
  .box { background: #fff; border-radius: 10px; box-shadow: 0 1px 4px rgba(0,0,0,0.1); padding: 32px 28px; max-width: 460px; text-align: center; }
  h1 { font-size: 1.25rem; color: #1a3a6b; margin: 0 0 10px; }
  p { font-size: 0.95rem; line-height: 1.5; margin: 0 0 18px; }
  a { display: inline-block; background: #1a3a6b; color: #fff; text-decoration: none; font-weight: 600; padding: 10px 18px; border-radius: 8px; }
  a:hover { background: #15305a; }
</style></head><body>
  <div class="box"><h1>${title}</h1><p>${message}</p>
    <a href="/reexam">Back to Reexam Determinations</a></div>
</body></html>`;
}

export default async function handler(req, res) {
  // ── Unsubscribe (GET, works directly from an email link) ──
  if (req.method === 'GET') {
    const token = String((req.query && req.query.token) || '').trim();
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    try {
      if (!token) { res.status(400).send(page('Invalid link', 'This unsubscribe link is missing its token.')); return; }
      const email = await removeReexamSubscriberByToken(token);
      if (email) res.status(200).send(page('Unsubscribed', `<strong>${email}</strong> has been removed from the daily reexamination determination alerts. You will not receive any further emails.`));
      else res.status(200).send(page('Already unsubscribed', 'This address is not on the list (it may have already been removed).'));
    } catch {
      res.status(500).send(page('Something went wrong', 'We could not process your unsubscribe request. Please try again later.'));
    }
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'Method not allowed.' });
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

    // ── Test email (does NOT subscribe the address) ──
    if (body.action === 'test') {
      const determinations = await listRecentDeterminations(15);
      const existing = await getReexamSubscriber(email);
      const token = existing ? existing.token : 'preview';
      const result = await sendReexamSubscriberDigest(email, determinations, {
        isTest: true, unsubscribeUrl: unsubscribeUrl(req, token),
      });
      if (result.error) { res.status(502).json({ ok: false, error: result.error }); return; }
      if (result.skipped) { res.status(400).json({ ok: false, error: result.reason }); return; }
      res.status(200).json({ ok: true, to: result.to, count: determinations.length });
      return;
    }

    // ── Subscribe ──
    const sub = await addReexamSubscriber(email);
    res.status(200).json({
      ok: true,
      existed: sub.existed,
      message: sub.existed
        ? 'This address is already subscribed.'
        : 'Subscribed. You will receive an email the morning after any new determinations issue.',
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: 'Request failed.', detail: String(err.message || err) });
  }
}
