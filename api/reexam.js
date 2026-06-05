// Returns recently detected reexamination determinations for the /reexam page.
//   GET /api/reexam  →  { determinations: [...] }
import { listRecentDeterminations } from '../lib/db.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed.' });
    return;
  }
  try {
    const determinations = await listRecentDeterminations(); // no limit
    res.status(200).json({ determinations });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load determinations.', detail: String(err.message || err) });
  }
}
