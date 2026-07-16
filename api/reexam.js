// Returns recently detected reexamination determinations for the /reexam page,
// or — with ?petitions=1 — post-grant patent owner petitions for /reexam-petitions.
//   GET /api/reexam              →  { determinations: [...] }
//   GET /api/reexam?petitions=1  →  { petitions: [...] }
//   GET /api/reexam?actions=1    →  { actions: [...] }
//   GET /api/reexam?manifest=1   →  a curl config (text) to bulk-download every
//                                   determination + office-action PDF locally.
import { listRecentDeterminations, listPostOrderPetitions, listReexamActions } from '../lib/db.js';
import { clientErrorDetail } from '../lib/secure.js';

const san = (s) => String(s || '').replace(/[^0-9A-Za-z._-]/g, '_');
const ymd = (s) => { const m = String(s || '').match(/(\d{4})-?(\d{2})-?(\d{2})/); return m ? `${m[1]}-${m[2]}-${m[3]}` : 'nodate'; };

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed.' });
    return;
  }
  try {
    // Always serve fresh data — no edge/browser caching — so updates from the cron
    // and backfills show up immediately rather than after a stale-cache window.
    res.setHeader('Cache-Control', 'no-store');
    // A curl config file: run `curl --create-dirs -K reexam-downloads.txt` to pull
    // every determination + office-action PDF into reexam-docs/ locally. Needs only
    // curl.exe (built into Windows 10/11) — no Node, npm, or PowerShell scripts.
    if (req.query && req.query.manifest) {
      // Env-only base (SEC-7): never derive links from the client-controlled Host
      // header. Requires APP_BASE_URL (or Vercel's production URL) to be set.
      const base = (process.env.APP_BASE_URL || (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : '')).replace(/\/$/, '');
      if (!base) { res.status(500).json({ error: 'APP_BASE_URL is not configured.' }); return; }
      const [dets, acts] = [await listRecentDeterminations(), await listReexamActions()];
      const lines = [];
      const add = (appNum, docId, dir, name) => {
        if (!appNum || !docId) return;
        lines.push(`url = "${base}/api/document?appNum=${encodeURIComponent(appNum)}&documentId=${encodeURIComponent(docId)}&format=PDF&disposition=attachment"`);
        lines.push(`output = "reexam-docs/${dir}/${name}.pdf"`);
      };
      for (const d of dets) add(d.application_number, d.document_identifier, 'determinations',
        `${san(d.application_number)}_${san(d.determination_type || 'determination')}_${ymd(d.official_date)}_${san(d.document_identifier)}`);
      for (const a of acts) {
        add(a.application_number, a.nonf_doc_id, 'office-actions', `${san(a.application_number)}_nonfinal_${ymd(a.nonf_date)}_${san(a.nonf_doc_id)}`);
        add(a.application_number, a.finl_doc_id, 'office-actions', `${san(a.application_number)}_final_${ymd(a.finl_date)}_${san(a.finl_doc_id)}`);
      }
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="reexam-downloads.txt"');
      res.status(200).send(lines.join('\n') + '\n');
      return;
    }
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
    res.status(500).json({ error: 'Failed to load.', detail: clientErrorDetail(err) });
  }
}
