// Serverless proxy for the USPTO Open Data Portal "Patent File Wrapper" search.
// Holds the X-API-KEY server-side so it never reaches the browser, and sidesteps CORS.
// Works on Vercel (api/ directory) out of the box. Node 18+ has global fetch.

const UPSTREAM = 'https://api.uspto.gov/api/v1/patent/applications/search';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed. Use POST.' });
    return;
  }

  const apiKey = process.env.USPTO_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'Server is missing the USPTO_API_KEY environment variable.' });
    return;
  }

  // Vercel parses JSON bodies automatically; fall back to manual parse otherwise.
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }

  try {
    const upstream = await fetch(UPSTREAM, {
      method: 'POST',
      headers: {
        'X-API-KEY': apiKey,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify(body || {}),
    });

    const text = await upstream.text();
    res.status(upstream.status);
    res.setHeader('Content-Type', 'application/json');
    res.send(text);
  } catch (err) {
    res.status(502).json({ error: 'Proxy request to USPTO failed.', detail: String(err) });
  }
}
