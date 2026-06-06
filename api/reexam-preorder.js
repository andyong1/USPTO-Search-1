// Returns patent-owner pre-order SNQ submissions and the total count of ex parte
// reexams filed since the cutoff (for the coverage statistic).
//   GET /api/reexam-preorder  →  { submissions: [...], totalFiled, cutoff }
import { listPreorder, PREORDER_CUTOFF } from '../lib/db.js';
import { searchApplications } from '../lib/uspto.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed.' });
    return;
  }
  try {
    const submissions = await listPreorder();

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

    res.status(200).json({ submissions, totalFiled, cutoff: PREORDER_CUTOFF });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load pre-order submissions.', detail: String(err.message || err) });
  }
}
