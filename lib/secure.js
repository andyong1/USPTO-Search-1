// Security helpers shared by the API handlers (SEC-1..5 of the July 2026 audit).
import crypto from 'node:crypto';

// Constant-time string comparison. Hashing both sides first equalizes length so
// timingSafeEqual can be used on arbitrary strings without leaking length.
export function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a ?? '')).digest();
  const hb = crypto.createHash('sha256').update(String(b ?? '')).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// Admin check — fails CLOSED: if ADMIN_PASSWORD is not configured, nothing is
// admin (previously it failed open, making every admin action public).
export function isAdmin(req) {
  const required = process.env.ADMIN_PASSWORD;
  if (!required) return false;
  return safeEqual(req.headers['x-admin-password'] || '', required);
}

// Cron gate — fails CLOSED when CRON_SECRET is unset. Accepts the secret from
// `Authorization: Bearer <secret>` or (transitionally) `?key=<secret>`.
// TODO(SEC-3): drop the ?key= fallback after rotating CRON_SECRET and pointing
// the external schedulers at the Authorization header.
export function cronOk(req) {
  const secret = (process.env.CRON_SECRET || '').trim();
  if (!secret) return false;
  const provided = ((req.headers.authorization || '').replace(/^Bearer\s+/i, '')
    || (req.query && req.query.key) || '').trim();
  return safeEqual(provided, secret);
}

// Per-recipient unsubscribe token for tracked-proceeding alerts: HMAC of the
// lowercased email keyed by CRON_SECRET (no extra env var or table). Rotating
// CRON_SECRET invalidates previously sent unsubscribe links — acceptable.
export function unsubToken(email) {
  const key = (process.env.CRON_SECRET || '').trim();
  if (!key) return '';
  return crypto.createHmac('sha256', key).update(String(email || '').trim().toLowerCase()).digest('hex').slice(0, 32);
}
export function unsubTokenOk(email, token) {
  const expected = unsubToken(email);
  return !!expected && !!token && safeEqual(expected, String(token));
}

// Client-facing error detail: log the full error server-side; return it to the
// client only outside production (raw messages can leak paths/upstream text).
export function clientErrorDetail(err) {
  console.error(err);
  return process.env.VERCEL_ENV === 'production' ? undefined : String((err && err.message) || err);
}
