// Daily reexam-determination alert subscriptions (single endpoint to stay within
// the Hobby plan's serverless-function limit).
//
//   POST /api/reexam-subscribe   { email }                          → subscribe
//   POST /api/reexam-subscribe   { email, action:"test" }           → send test email
//   GET  /api/reexam-subscribe?token=...                            → unsubscribe CONFIRM page
//   POST /api/reexam-subscribe   action=unsubscribe & token=...     → perform unsubscribe
//
// Unsubscribe is a two-step GET→POST flow on purpose: email security scanners
// pre-fetch link URLs (GET), so destructive removal must not happen on GET.
import {
  addReexamSubscriber, removeReexamSubscriberByToken, getReexamSubscriber,
  listRecentDeterminations,
} from '../lib/db.js';
import { sendReexamSubscriberDigest } from '../lib/email.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Light in-memory per-IP rate limit for subscribe/test (best-effort: persists
// only within a warm serverless instance, which is enough to blunt scripted abuse).
const RL_WINDOW_MS = 60 * 1000;
const RL_MAX = 5; // subscribe/test attempts per IP per window
const rlHits = new Map();
function rateLimited(req) {
  const fwd = req.headers['x-forwarded-for'] || '';
  const ip = (Array.isArray(fwd) ? fwd[0] : String(fwd)).split(',')[0].trim()
    || req.headers['x-real-ip'] || 'unknown';
  const now = Date.now();
  const arr = (rlHits.get(ip) || []).filter((t) => now - t < RL_WINDOW_MS);
  arr.push(now);
  rlHits.set(ip, arr);
  if (rlHits.size > 5000) { // crude memory cap
    for (const [k, v] of rlHits) { if (!v.length || now - v[v.length - 1] > RL_WINDOW_MS) rlHits.delete(k); }
  }
  return arr.length > RL_MAX;
}

function baseUrl(req) {
  if (process.env.APP_BASE_URL) return process.env.APP_BASE_URL.replace(/\/$/, '');
  const host = process.env.VERCEL_PROJECT_PRODUCTION_URL || (req && req.headers && req.headers.host);
  return host ? `https://${host}` : '';
}

function unsubscribeUrl(req, token) {
  return `${baseUrl(req)}/api/reexam-subscribe?token=${encodeURIComponent(token)}`;
}

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function page(title, inner) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${esc(title)}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f0f4f8; color: #2d3748; display: flex; min-height: 100vh; align-items: center; justify-content: center; margin: 0; padding: 24px; }
  .box { background: #fff; border-radius: 10px; box-shadow: 0 1px 4px rgba(0,0,0,0.1); padding: 32px 28px; max-width: 460px; text-align: center; }
  h1 { font-size: 1.25rem; color: #1a3a6b; margin: 0 0 10px; }
  p { font-size: 0.95rem; line-height: 1.5; margin: 0 0 18px; }
  .btn { display: inline-block; background: #1a3a6b; color: #fff; border: none; cursor: pointer; text-decoration: none; font-weight: 600; font-size: 0.95rem; padding: 10px 18px; border-radius: 8px; }
  .btn:hover { background: #15305a; }
  .btn.muted { background: #e2e8f0; color: #1a3a6b; margin-left: 8px; }
  .btn.muted:hover { background: #cbd5e0; }
</style></head><body>
  <div class="box"><h1>${esc(title)}</h1>${inner}</div>
</body></html>`;
}

const backBtn = `<a class="btn muted" href="/reexam">Back to Reexam Determinations</a>`;

export default async function handler(req, res) {
  // ── Unsubscribe — GET shows a confirmation page (no state change), so email
  // link-scanners that pre-fetch the URL don't unsubscribe people. The actual
  // removal happens only when the user submits the form (POST). ──
  if (req.method === 'GET') {
    const token = String((req.query && req.query.token) || '').trim();
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (!token) {
      res.status(400).send(page('Invalid link', `<p>This unsubscribe link is missing its token.</p>${backBtn}`));
      return;
    }
    res.status(200).send(page('Unsubscribe',
      `<p>Click below to stop receiving daily ex parte reexamination determination alerts.</p>
       <form method="POST" action="/api/reexam-subscribe" style="margin:0">
         <input type="hidden" name="action" value="unsubscribe" />
         <input type="hidden" name="token" value="${esc(token)}" />
         <button class="btn" type="submit">Unsubscribe</button>${backBtn}
       </form>`));
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'Method not allowed.' });
    return;
  }

  try {
    let body = req.body;
    if (typeof body === 'string') {
      // Could be JSON (fetch) or x-www-form-urlencoded (the unsubscribe form).
      try { body = JSON.parse(body); }
      catch { body = Object.fromEntries(new URLSearchParams(body)); }
    }
    body = body || {};

    // ── Confirmed unsubscribe — from the form submit, or an RFC 8058 one-click
    // POST (body "List-Unsubscribe=One-Click", token in the query string). ──
    const oneClick = body['List-Unsubscribe'] === 'One-Click';
    const qToken = req.query && req.query.token;
    const qAction = req.query && req.query.action;
    if (body.action === 'unsubscribe' || oneClick || qAction === 'unsubscribe') {
      const token = String(body.token || qToken || '').trim();
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      try {
        const email = token ? await removeReexamSubscriberByToken(token) : null;
        if (email) {
          res.status(200).send(page('Unsubscribed',
            `<p>You have been unsubscribed. <strong>${esc(email)}</strong> will not receive any further daily reexamination determination alerts.</p>${backBtn}`));
        } else {
          res.status(200).send(page('Already unsubscribed',
            `<p>This address is not on the list (it may have already been removed).</p>${backBtn}`));
        }
      } catch {
        res.status(500).send(page('Something went wrong',
          `<p>We could not process your unsubscribe request. Please try again later.</p>${backBtn}`));
      }
      return;
    }

    // Rate-limit subscribe/test (unsubscribe above is intentionally never limited).
    if (rateLimited(req)) {
      res.status(429).json({ ok: false, error: 'Too many requests. Please wait a minute and try again.' });
      return;
    }

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
