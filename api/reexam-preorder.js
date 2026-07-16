// Returns patent owner pre-order SNQ submissions and the total count of ex parte
// reexams filed since the cutoff (for the coverage statistic).
//   GET /api/reexam-preorder  →  { submissions: [...], totalFiled, cutoff }
import { listPreorder, preorderEffectStats, getPreorderCounts, PREORDER_CUTOFF } from '../lib/db.js';
import { fetchPreorderCoverage } from '../lib/uspto.js';
import { clientErrorDetail } from '../lib/secure.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed.' });
    return;
  }
  try {
    const [submissions, effect, counts] = await Promise.all([listPreorder(), preorderEffectStats(), getPreorderCounts()]);

    // Coverage denominators are precomputed daily by the cron (no live USPTO calls
    // on the hot path). Fall back to computing them live only if the cron hasn't
    // populated them yet (e.g. right after first deploy).
    let totalFiled = counts.preorder_total_filed;
    let deadlinePassed = counts.preorder_deadline_passed;
    if (totalFiled == null && deadlinePassed == null) {
      try { ({ totalFiled, deadlinePassed } = await fetchPreorderCoverage(PREORDER_CUTOFF)); }
      catch { /* leave whatever we have */ }
    }

    // Always serve fresh data — no caching — so backfill/cron updates show immediately.
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({ submissions, effect, totalFiled, deadlinePassed, cutoff: PREORDER_CUTOFF });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load pre-order submissions.', detail: clientErrorDetail(err) });
  }
}
