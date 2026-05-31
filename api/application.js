// Serverless proxy for single-application lookups against the USPTO ODP.
// GET /api/application?appNum=16123456&section=meta-data
// Forwards to https://api.uspto.gov/api/v1/patent/applications/{appNum}[/{section}]

const BASE = 'https://api.uspto.gov/api/v1/patent/applications';

const ALLOWED_SECTIONS = new Set([
  '',                     // full record
  'meta-data',            // bibliographic data
  'documents',            // filed/issued documents
  'continuity',           // parent/child continuity
  'foreign-priority',     // foreign priority claims
  'assignment',           // assignment / ownership
  'transactions',         // prosecution history
  'associated-documents', // associated docs
]);

export default async function handler(req, res) {
  const apiKey = process.env.USPTO_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'Server is missing the USPTO_API_KEY environment variable.' });
    return;
  }

  const appNum = (req.query.appNum || '').trim();
  const section = (req.query.section || '').trim();

  if (!appNum || !/^[0-9A-Za-z/]+$/.test(appNum)) {
    res.status(400).json({ error: 'Missing or invalid appNum.' });
    return;
  }
  if (!ALLOWED_SECTIONS.has(section)) {
    res.status(400).json({ error: 'Invalid section.' });
    return;
  }

  const path = section ? `/${section}` : '';
  const url = `${BASE}/${encodeURIComponent(appNum)}${path}`;

  try {
    const upstream = await fetch(url, {
      headers: { 'X-API-KEY': apiKey, 'Accept': 'application/json' },
    });
    const text = await upstream.text();
    res.status(upstream.status);
    res.setHeader('Content-Type', 'application/json');
    res.send(text);
  } catch (err) {
    res.status(502).json({ error: 'Proxy request to USPTO failed.', detail: String(err) });
  }
}
