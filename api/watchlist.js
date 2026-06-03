// CRUD for the proceedings you track + listing detected new filings.
//   GET    /api/watchlist                                              → { watched, findings }
//   POST   /api/watchlist  { applicationNumber, label, recipients }    → add + baseline sync
//   POST   /api/watchlist  { action: "updateRecipients", applicationNumber, recipients }
//   POST   /api/watchlist  { action: "acknowledge" [, applicationNumber, documentIdentifier] }
//   DELETE /api/watchlist?applicationNumber=...                        → stop tracking

import {
  listWatched, addWatched, removeWatched, setRecipients,
  listFindings, acknowledgeFindings, acknowledgeFinding, syncApplication,
} from '../lib/db.js';

// Clean a recipient string into a normalized comma-separated list (or null).
function normalizeRecipients(s) {
  const list = String(s || '').split(/[,;]/).map((x) => x.trim()).filter(Boolean);
  return list.length ? list.join(', ') : null;
}

export default async function handler(req, res) {
  try {
    if (req.method === 'GET') {
      const [watched, findings] = await Promise.all([listWatched(), listFindings()]);
      res.status(200).json({ watched, findings });
      return;
    }

    if (req.method === 'POST') {
      let body = req.body;
      if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
      body = body || {};

      if (body.action === 'acknowledge') {
        // Acknowledge a single finding if identified, otherwise all of them.
        if (body.applicationNumber && body.documentIdentifier) {
          await acknowledgeFinding(String(body.applicationNumber), String(body.documentIdentifier));
        } else {
          await acknowledgeFindings();
        }
        res.status(200).json({ ok: true });
        return;
      }

      if (body.action === 'updateRecipients') {
        const num = String(body.applicationNumber || '').replace(/[^0-9A-Za-z/]/g, '');
        if (!num) { res.status(400).json({ error: 'applicationNumber is required.' }); return; }
        await setRecipients(num, normalizeRecipients(body.recipients));
        const watched = await listWatched();
        res.status(200).json({ ok: true, watched });
        return;
      }

      const appNum = String(body.applicationNumber || '').replace(/[^0-9A-Za-z/]/g, '');
      if (!appNum) { res.status(400).json({ error: 'applicationNumber is required.' }); return; }

      await addWatched(appNum, body.label, normalizeRecipients(body.recipients));

      // Baseline existing documents so only FUTURE filings count as "new".
      let baseline = null;
      try { baseline = await syncApplication(appNum, false); }
      catch (e) { baseline = { error: String(e.message || e) }; }

      const watched = await listWatched();
      res.status(200).json({ ok: true, watched, baseline });
      return;
    }

    if (req.method === 'DELETE') {
      const appNum = String(req.query.applicationNumber || '').replace(/[^0-9A-Za-z/]/g, '');
      if (!appNum) { res.status(400).json({ error: 'applicationNumber is required.' }); return; }
      await removeWatched(appNum);
      res.status(200).json({ ok: true });
      return;
    }

    res.status(405).json({ error: 'Method not allowed.' });
  } catch (err) {
    res.status(500).json({ error: 'Watchlist operation failed.', detail: String(err.message || err) });
  }
}
