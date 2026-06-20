// CRUD for the proceedings you track + listing detected new filings.
//   GET    /api/watchlist                                              → { watched, findings }
//   POST   /api/watchlist  { applicationNumber, label, recipients }    → add + baseline sync
//   POST   /api/watchlist  { action: "updateRecipients", applicationNumber, recipients }   [admin]
//   POST   /api/watchlist  { action: "acknowledge" [, applicationNumber, documentIdentifier] }
//   DELETE /api/watchlist?applicationNumber=...                        → stop tracking      [admin]
//
// "[admin]" actions require the X-Admin-Password header to match the
// ADMIN_PASSWORD env var (enforced only if ADMIN_PASSWORD is set).

import {
  listWatched, addWatched, removeWatched, setRecipients,
  listFindings, acknowledgeFindings, acknowledgeFinding, syncApplication,
  getStatusSnapshot, listReexamSubscribers,
} from '../lib/db.js';

// Clean a recipient string into a normalized comma-separated list (or null).
function normalizeRecipients(s) {
  const list = String(s || '').split(/[,;]/).map((x) => x.trim()).filter(Boolean);
  return list.length ? list.join(', ') : null;
}

// True if admin protection passes. If ADMIN_PASSWORD isn't set, protection is
// off (returns true) so the app still works until you configure it.
function isAdmin(req) {
  const required = process.env.ADMIN_PASSWORD;
  if (!required) return true;
  return (req.headers['x-admin-password'] || '') === required;
}

// Recipient emails are PII — strip them for non-admin callers so the public
// /api/watchlist response can't be scraped for addresses. Admins (valid
// X-Admin-Password) still get them, which powers the recipient-edit flow.
function maskWatched(watched, req) {
  if (isAdmin(req)) return watched;
  return watched.map((w) => { const { recipients, ...rest } = w; return rest; });
}

export default async function handler(req, res) {
  try {
    if (req.method === 'GET') {
      // Admin-only operational snapshot for the /status page.
      if (req.query && req.query.status) {
        if (!isAdmin(req)) { res.status(401).json({ error: 'Incorrect or missing admin password.' }); return; }
        res.setHeader('Cache-Control', 'no-store');
        res.status(200).json({ status: await getStatusSnapshot() });
        return;
      }
      // Admin-only: the daily-email subscriber list (emails only, no tokens).
      if (req.query && req.query.subscribers) {
        if (!isAdmin(req)) { res.status(401).json({ error: 'Incorrect or missing admin password.' }); return; }
        res.setHeader('Cache-Control', 'no-store');
        const subs = await listReexamSubscribers();
        res.status(200).json({ subscribers: subs.map((s) => s.email), count: subs.length });
        return;
      }
      // Admin-only: tracked proceedings + the alert recipients for each.
      if (req.query && req.query.tracked) {
        if (!isAdmin(req)) { res.status(401).json({ error: 'Incorrect or missing admin password.' }); return; }
        res.setHeader('Cache-Control', 'no-store');
        const watched = await listWatched();
        res.status(200).json({ tracked: watched.map((w) => ({ application_number: w.application_number, label: w.label, recipients: w.recipients })) });
        return;
      }
      const [watched, findings] = await Promise.all([listWatched(), listFindings()]);
      res.status(200).json({ watched: maskWatched(watched, req), findings });
      return;
    }

    if (req.method === 'POST') {
      let body = req.body;
      if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
      body = body || {};

      if (body.action === 'verifyAdmin') {
        if (!isAdmin(req)) { res.status(401).json({ error: 'Incorrect or missing admin password.' }); return; }
        res.status(200).json({ ok: true });
        return;
      }

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
        if (!isAdmin(req)) { res.status(401).json({ error: 'Incorrect or missing admin password.' }); return; }
        const num = String(body.applicationNumber || '').replace(/[^0-9A-Za-z/]/g, '');
        if (!num) { res.status(400).json({ error: 'applicationNumber is required.' }); return; }
        await setRecipients(num, normalizeRecipients(body.recipients));
        const watched = await listWatched();
        res.status(200).json({ ok: true, watched: maskWatched(watched, req) });
        return;
      }

      const appNum = String(body.applicationNumber || '').replace(/[^0-9A-Za-z/]/g, '');
      if (!appNum) { res.status(400).json({ error: 'applicationNumber is required.' }); return; }

      const addResult = await addWatched(appNum, body.label, normalizeRecipients(body.recipients));

      // Baseline existing documents so only FUTURE filings count as "new".
      let baseline = null;
      try { baseline = await syncApplication(appNum, false); }
      catch (e) { baseline = { error: String(e.message || e) }; }

      const watched = await listWatched();
      res.status(200).json({ ok: true, watched: maskWatched(watched, req), baseline, existed: addResult.existed });
      return;
    }

    if (req.method === 'DELETE') {
      if (!isAdmin(req)) { res.status(401).json({ error: 'Incorrect or missing admin password.' }); return; }
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
