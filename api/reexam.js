// Returns recently detected reexamination determinations for the /reexam page,
// or — with ?petitions=1 — post-grant patent owner petitions for /reexam-petitions.
//   GET /api/reexam              →  { determinations: [...] }
//   GET /api/reexam?petitions=1  →  { petitions: [...] }
import { listRecentDeterminations, listPostOrderPetitions, listReexamActions } from '../lib/db.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed.' });
    return;
  }
  try {
    if (req.query && req.query.petitions) {
      const petitions = await listPostOrderPetitions();
      res.status(200).json({ petitions });
      return;
    }
    if (req.query && req.query.actions) {
      const actions = await listReexamActions();
      res.status(200).json({ actions });
      return;
    }
    const determinations = await listRecentDeterminations(); // no limit
    res.status(200).json({ determinations });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load.', detail: String(err.message || err) });
  }
}
