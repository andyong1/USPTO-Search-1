// Streams an application document (PDF/XML/DOCX) through the proxy, injecting the
// API key. The browser can't hit the USPTO download URL directly because it needs
// the X-API-KEY header. The upstream host is hard-coded (no open-proxy / SSRF risk).
//   GET /api/document?appNum=16123456&documentId=KEEQMGWJLDFLYX4&format=PDF
//
// disposition=inline  → render in the browser/iframe (forces the real content-type,
//                       since USPTO often returns application/octet-stream which
//                       browsers would otherwise download).
// disposition=attachment (default) → force a download.
//
// USPTO's download gateway intermittently returns 504s, so each request is given a
// bounded timeout and retried once. On final failure an inline request gets a small
// readable HTML page (so the viewer/new-tab shows a message, not raw JSON).

export const config = { maxDuration: 60 };

const DL_BASE = 'https://api.uspto.gov/api/v1/download/applications';
const ATTEMPTS = 2;
const ATTEMPT_TIMEOUT_MS = 24000;

const EXT = { PDF: 'pdf', XML: 'xml', 'MS WORD': 'docx', DOCX: 'docx', DOC: 'docx' };
const CTYPE = { pdf: 'application/pdf', xml: 'application/xml', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };

async function fetchWithTimeout(url, opts, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ctrl.signal }); }
  finally { clearTimeout(timer); }
}

function errorPageHtml(status) {
  const timedOut = status === 504 || status === 408 || status === 0;
  const msg = timedOut
    ? 'The USPTO document service timed out while retrieving this file. This is usually temporary — please try again in a few minutes.'
    : `The USPTO document service returned an error (HTTP ${status}) for this file. Please try again later.`;
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Document unavailable</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #525659; color: #e2e8f0; display: flex; min-height: 100vh; align-items: center; justify-content: center; margin: 0; padding: 24px; }
  .box { max-width: 460px; text-align: center; line-height: 1.55; }
  h1 { font-size: 1.1rem; margin: 0 0 10px; color: #fff; }
  p { font-size: 0.95rem; margin: 0; color: #cbd5e0; }
</style></head><body>
  <div class="box"><h1>Document temporarily unavailable</h1><p>${msg}</p></div>
</body></html>`;
}

export default async function handler(req, res) {
  const apiKey = process.env.USPTO_API_KEY;
  if (!apiKey) { res.status(500).json({ error: 'Server missing USPTO_API_KEY.' }); return; }

  const appNum     = String(req.query.appNum || '').replace(/[^0-9A-Za-z/]/g, '');
  const documentId = String(req.query.documentId || '').replace(/[^0-9A-Za-z._-]/g, '');
  const format     = String(req.query.format || 'PDF').toUpperCase();
  const ext        = EXT[format] || 'pdf';
  const inline     = String(req.query.disposition || '').toLowerCase() === 'inline';

  if (!appNum || !documentId) {
    res.status(400).json({ error: 'appNum and documentId are required.' });
    return;
  }

  const url = `${DL_BASE}/${encodeURIComponent(appNum)}/${encodeURIComponent(documentId)}.${ext}`;
  const filename = `${appNum}-${documentId}.${ext}`;

  let lastStatus = 0;
  let lastDetail = '';
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    try {
      const upstream = await fetchWithTimeout(url, { headers: { 'X-API-KEY': apiKey } }, ATTEMPT_TIMEOUT_MS);
      if (upstream.ok) {
        const buf = Buffer.from(await upstream.arrayBuffer());
        if (inline) {
          // Force the true content-type so the browser renders it instead of downloading.
          // (USPTO frequently labels downloads as application/octet-stream.)
          const upstreamType = upstream.headers.get('content-type') || '';
          const isGeneric = !upstreamType || /octet-stream|force-download|application\/download/i.test(upstreamType);
          res.setHeader('Content-Type', (isGeneric ? CTYPE[ext] : upstreamType) || CTYPE[ext] || 'application/octet-stream');
          res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
        } else {
          res.setHeader('Content-Type', upstream.headers.get('content-type') || CTYPE[ext] || 'application/octet-stream');
          res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        }
        res.status(200).send(buf);
        return;
      }
      lastStatus = upstream.status;
      lastDetail = (await upstream.text().catch(() => '')).slice(0, 200);
      if (upstream.status < 500 && upstream.status !== 408) break; // 4xx won't change on retry
    } catch (err) {
      lastStatus = 504; // aborted/timed out
      lastDetail = String(err.message || err);
    }
  }

  // All attempts failed.
  if (inline) {
    res.status(200).setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(errorPageHtml(lastStatus));
  } else {
    res.status(502).json({ error: `Download failed: HTTP ${lastStatus}`, detail: lastDetail });
  }
}
