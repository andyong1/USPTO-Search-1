// On-demand scan for patent-owner pre-order SNQ submissions (RX.PRO.PO) across
// ex parte reexams filed on/after the cutoff — including ones already determined.
// Trigger manually: GET /api/cron/backfill-preorder?key=<CRON_SECRET>
// Processes as many as it can within a time budget; run until done is true.

import {
  getReexamsForPreorderBackfill, markPreorderChecked, recordPreorder,
  updatePreorderPetition, countReexamsForPreorderBackfill, resetPreorderChecked, PREORDER_CUTOFF,
  upsertReexams, recordDetermination,
} from '../../lib/db.js';
import { fetchDocuments, fetchMetaData, analyzePetition } from '../../lib/uspto.js';

const DET_CODES = { RXREXO: 'Reexam Ordered', RXREXD: 'Reexam Denied' };

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
    // ?app=<control no> — pull one specific reexam directly (no dependence on the
    // rolling scan/enumeration): record its pre-order submission/petition/decision/
    // determination and add it to the watch list.
    if (req.query && req.query.app) {
      const appNum = String(req.query.app).replace(/[^0-9A-Za-z]/g, '');
      const PREORDER_CODE = 'RX.PRO.PO';
      const meta = await fetchMetaData(appNum);
      const filingDate = meta.filingDate || null;
      const docs = await fetchDocuments(appNum);
      const preDocs = docs.filter((x) => (x.documentCode || '').toUpperCase() === PREORDER_CODE);

      if (filingDate) await upsertReexams([{ applicationNumber: appNum, filingDate }]);

      let found = 0;
      for (const d of preDocs) {
        const isNew = await recordPreorder({ applicationNumber: appNum, documentIdentifier: d.documentIdentifier, officialDate: d.officialDate, filingDate });
        if (isNew) found++;
      }
      if (preDocs.length) {
        const { petition, decision } = analyzePetition(docs, preDocs[0].officialDate);
        await updatePreorderPetition(appNum, petition, decision);
      }
      // Record any determination too (feeds the Determination column).
      for (const d of docs) {
        if (DET_CODES[d.documentCode]) {
          await recordDetermination({ applicationNumber: appNum, documentIdentifier: d.documentIdentifier, code: d.documentCode, type: DET_CODES[d.documentCode], officialDate: d.officialDate, groupArtUnit: meta.groupArtUnit, examiner: meta.examiner });
        }
      }

      res.status(200).json({
        ok: true, app: appNum, filingDate, cutoff: PREORDER_CUTOFF,
        preorderDocsFound: preDocs.length, newlyRecorded: found,
        willAppear: !!(filingDate && filingDate >= PREORDER_CUTOFF && preDocs.length),
        note: !preDocs.length ? 'No RX.PRO.PO pre-order document found on this application yet.'
          : (filingDate && filingDate < PREORDER_CUTOFF) ? 'Filing date is before the Apr 5, 2026 cutoff, so it will not be listed.' : undefined,
      });
      return;
    }

    // ?reset=1 re-checks all post-cutoff reexams (e.g., to pick up granted decisions).
    let reset = 0;
    if (req.query && req.query.reset === '1') reset = await resetPreorderChecked();

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
    res.status(200).json({ ok: true, cutoff: PREORDER_CUTOFF, reset, processed, found, remaining, done: remaining === 0 });
  } catch (err) {
    res.status(500).json({ error: 'Pre-order backfill failed.', detail: String(err.message || err) });
  }
}
