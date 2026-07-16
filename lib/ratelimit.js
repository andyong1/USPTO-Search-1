// Light in-memory per-IP rate limit shared by the public POST endpoints
// (best-effort: state persists only within a warm serverless instance, which is
// enough to blunt scripted abuse). Extracted from api/reexam-subscribe.js.
const RL_WINDOW_MS = 60 * 1000;
const rlHits = new Map();

export function rateLimited(req, max = 5) {
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
  return arr.length > max;
}
