// On-demand scan for patent-owner pre-order SNQ submissions (RX.PRO.PO) across
// ex parte reexams filed on/after the cutoff — including ones already determined.
// Trigger manually: GET /api/cron/backfill-preorder?key=<CRON_SECRET>
// Processes as many as it can within a time budget; run until done is true.

import {
  getReexamsForPreorderBackfill, markPreorderChecked, recordPreorder,
  updatePreorderPetition, countReexamsForPreorderBackfill, PREORDER_CUTOFF,
} from '../../lib/db.js';
import { fetchDocuments, analyzePetition } from '../../lib/uspto.js';

export const config = { maxDuration: 60 };

const CONCURRENCY = 5;
const TIME_BUDGET_MS = 50000;
const PREORDER_CODE = 'RX.PRO.PO';

export default async function handler(req, res) {
  const secret = (process.env.CRON_SECRET || '').trim();
  const provided = ((req.headers.authorization || '').replace(/^Bearer\s+/i, '')
    || (req.query && req.query.key) || '').trim();
  if (secret && provided !== secret) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  try {
    const deadline = Date.now() + TIME_BUDGET_MS;
    let processed = 0, found = 0;

    while (Date.now() < deadline) {
      const rows = await getReexamsForPreorderBackfill(CONCURRENCY);
      if (!rows.length) break;
      await Promise.all(rows.map(async (row) => {
        const appNum = row.application_number;
        try {
          const docs = await fetchDocuments(appNum);
          const preDocs = docs.filter((x) => (x.documentCode || '').toUpperCase() === PREORDER_CODE);
          for (const d of preDocs) {
            const isNew = await recordPreorder({
              applicationNumber: appNum,
              documentIdentifier: d.documentIdentifier,
              officialDate: d.officialDate,
              filingDate: row.filing_date,
            });
            if (isNew) found++;
          }
          if (preDocs.length) {
            const { petition, decision } = analyzePetition(docs, preDocs[0].officialDate);
            await updatePreorderPetition(appNum, petition, decision);
          }
        } catch { /* leave unmarked; retried next run */ return; }
        await markPreorderChecked(appNum);
        processed++;
      }));
    }

    const remaining = await countReexamsForPreorderBackfill();
    res.status(200).json({ ok: true, cutoff: PREORDER_CUTOFF, processed, found, remaining, done: remaining === 0 });
  } catch (err) {
    res.status(500).json({ error: 'Pre-order backfill failed.', detail: String(err.message || err) });
  }
}
