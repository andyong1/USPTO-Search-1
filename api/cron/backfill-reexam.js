// On-demand backfill of examiner name + group art unit for existing reexam
// determinations (rather than waiting for the hourly reexam-scan to do 10/run).
// Trigger manually: GET /api/cron/backfill-reexam?key=<CRON_SECRET>
// Processes as many as it can within a time budget, then returns how many remain.
// If "done" is false, call it again until done is true.

import {
  getAppsMissingDeterminationMeta, updateDeterminationMeta, resetEmptyDeterminationMeta,
  getOrderedReexamsToCheckPetitions, getPetitionsToParse,
} from '../../lib/db.js';
import { fetchMetaData } from '../../lib/uspto.js';
import { detectPetitionsForApp, parseOnePetition } from '../../lib/petitions.js';

export const config = { maxDuration: 60 };

const CONCURRENCY = 5;
const TIME_BUDGET_MS = 50000; // stop before the 60s function limit

export default async function handler(req, res) {
  const secret = (process.env.CRON_SECRET || '').trim();
  const provided = ((req.headers.authorization || '').replace(/^Bearer\s+/i, '')
    || (req.query && req.query.key) || '').trim();
  if (secret && provided !== secret) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  try {
    // ?petitions=1 — backfill post-grant PET.OP petitions across all ordered
    // reexams, then 325(d)-parse the ones found. Run until done is true.
    if (req.query && req.query.petitions === '1') {
      const deadline = Date.now() + TIME_BUDGET_MS;
      let scanned = 0, detected = 0, parsed = 0;
      while (Date.now() < deadline) {
        const apps = await getOrderedReexamsToCheckPetitions(CONCURRENCY);
        if (!apps.length) break;
        for (const a of apps) {
          if (Date.now() > deadline) break;
          try { detected += await detectPetitionsForApp(a.application_number, a.order_date); scanned++; }
          catch { /* leave unscanned; retried next call */ }
        }
      }
      const toParse = await getPetitionsToParse(60);
      const parseErrors = [];
      for (const r of toParse) {
        if (Date.now() > deadline) break;
        try { await parseOnePetition(r); parsed++; }
        catch (e) { parseErrors.push({ app: r.application_number, error: String(e.message || e) }); }
      }
      const remainingScan = (await getOrderedReexamsToCheckPetitions(100000)).length;
      const remainingParse = (await getPetitionsToParse(100000)).length;
      res.status(200).json({ ok: true, mode: 'petitions', scanned, detected, parsed, remainingScan, remainingParse, done: remainingScan === 0 && remainingParse === 0, parseErrors: parseErrors.slice(0, 5) });
      return;
    }

    // ?reset=1 re-pools rows that previously ended up blank, so they get retried.
    let reset = 0;
    if (req.query && req.query.reset === '1') reset = await resetEmptyDeterminationMeta();

    const deadline = Date.now() + TIME_BUDGET_MS;
    let processed = 0;

    while (Date.now() < deadline) {
      const apps = await getAppsMissingDeterminationMeta(CONCURRENCY);
      if (!apps.length) break;
      await Promise.all(apps.map(async (appNum) => {
        try {
          const m = await fetchMetaData(appNum);
          await updateDeterminationMeta(appNum, m.groupArtUnit, m.examiner);
          processed++;
        } catch { /* mark nothing; will be retried on a later call */ }
      }));
    }

    const remaining = (await getAppsMissingDeterminationMeta(100000)).length;
    res.status(200).json({ ok: true, reset, processed, remaining, done: remaining === 0 });
  } catch (err) {
    res.status(500).json({ error: 'Backfill failed.', detail: String(err.message || err) });
  }
}
