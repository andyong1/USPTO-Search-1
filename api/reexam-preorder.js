// Returns patent-owner pre-order SNQ submissions and the total count of ex parte
// reexams filed since the cutoff (for the coverage statistic).
//   GET /api/reexam-preorder  →  { submissions: [...], totalFiled, cutoff }
import { listPreorder, preorderEffectStats, PREORDER_CUTOFF } from '../lib/db.js';
import { searchApplications } from '../lib/uspto.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed.' });
    return;
  }
  try {
    const [submissions, effect] = await Promise.all([listPreorder(), preorderEffectStats()]);

    // Live total of ex parte reexams filed on/after the cutoff.
    let totalFiled = null;
    try {
      const data = await searchApplications({
        q: 'applicationNumberText:90*',
        rangeFilters: [{ field: 'applicationMetaData.filingDate', valueFrom: PREORDER_CUTOFF, valueTo: '2100-01-01' }],
        pagination: { offset: 0, limit: 1 },
      });
      totalFiled = data.count ?? data.totalNumFound ?? null;
    } catch { /* leave null */ }

    // Reexams filed on/after the cutoff whose 30-day pre-order window has elapsed
    // (filing date on/before today − 30 days). Used for the coverage denominator.
    let deadlinePassed = null;
    const cutoffMinus30 = new Date();
    cutoffMinus30.setUTCDate(cutoffMinus30.getUTCDate() - 30);
    const passedTo = cutoffMinus30.toISOString().slice(0, 10);
    if (passedTo >= PREORDER_CUTOFF) {
      try {
        const data = await searchApplications({
          q: 'applicationNumberText:90*',
          rangeFilters: [{ field: 'applicationMetaData.filingDate', valueFrom: PREORDER_CUTOFF, valueTo: passedTo }],
          pagination: { offset: 0, limit: 1 },
        });
        deadlinePassed = data.count ?? data.totalNumFound ?? null;
      } catch { /* leave null */ }
    } else {
      deadlinePassed = 0; // we're still within 30 days of the cutoff
    }

    res.status(200).json({ submissions, effect, totalFiled, deadlinePassed, cutoff: PREORDER_CUTOFF });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load pre-order submissions.', detail: String(err.message || err) });
  }
}
