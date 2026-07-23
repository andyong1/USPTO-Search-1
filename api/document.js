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
// The upstream body is STREAMED straight to the client (not buffered), so large
// PDFs start rendering immediately instead of waiting for the whole file. The
// timeout covers only the initial response; once bytes are flowing they stream
// freely (bounded by maxDuration). USPTO occasionally 504s, so a failed initial
// request is retried once, and an inline failure returns a readable HTML notice.

import { Readable } from 'node:stream';
import { clientErrorDetail } from '../lib/secure.js';
import { getDeterminationByDoc } from '../lib/db.js';

export const config = { maxDuration: 60 };

const DL_BASE = 'https://api.uspto.gov/api/v1/download/applications';
const META_BASE = 'https://api.uspto.gov/api/v1/patent/applications';
const ATTEMPTS = 2;
const CONNECT_TIMEOUT_MS = 25000;

// Resolve a document's real download URL from its metadata. Most docs are served
// at the constructed {docId}.{ext}, but some (e.g. certain petitions) live at a
// nested {docId}/files/{fileId}.{ext} path and 400 on the constructed URL.
async function resolveRealUrl(appNum, documentId, format, apiKey) {
  try {
    const r = await fetchHeaders(`${META_BASE}/${encodeURIComponent(appNum)}/documents`,
      { headers: { 'X-API-KEY': apiKey, Accept: 'application/json' } }, 10000);
    if (!r.ok) return null;
    const data = await r.json();
    const bag = data.documentBag || data.documents || [];
    const want = String(format).toUpperCase();
    const pdfOpt = (doc) => (doc.downloadOptionBag || doc.downloadOptions || []).find((o) => {
      const m = String(o.mimeTypeIdentifier || o.mimeType || '').toUpperCase();
      return want === 'PDF' ? m.includes('PDF') : m.includes(want);
    });
    let doc = bag.find((d) => (d.documentIdentifier || d.documentId) === documentId);
    if (!doc || !pdfOpt(doc)) {
      // The stored id can go stale: the USPTO sometimes RE-ISSUES a very recent
      // document under a new identifier (common for freshly-filed determinations,
      // which is exactly what /filings-trends surfaces). If we recorded this as a
      // determination, recover the live doc by matching its code (preferring the
      // same official date) so the View/Download link keeps working.
      const det = await getDeterminationByDoc(appNum, documentId).catch(() => null);
      if (det && det.code) {
        const code = String(det.code).toUpperCase();
        const day = String(det.official_date || '').slice(0, 10);
        const matches = bag.filter((d) => String(d.documentCode || '').toUpperCase() === code && pdfOpt(d));
        doc = matches.find((d) => String(d.officialDate || '').slice(0, 10) === day)
          || matches.sort((a, b) => String(b.officialDate || '').localeCompare(String(a.officialDate || '')))[0]
          || doc;
      }
    }
    const opt = doc && pdfOpt(doc);
    return (opt && (opt.downloadUrl || opt.url)) || null;
  } catch { return null; }
}

const EXT = { PDF: 'pdf', XML: 'xml', 'MS WORD': 'docx', DOCX: 'docx', DOC: 'docx' };
const CTYPE = { pdf: 'application/pdf', xml: 'application/xml', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };

// Resolves once the response HEADERS arrive (fetch resolves before the body is
// read), then the abort timer is cleared so streaming the body isn't cut short.
async function fetchHeaders(url, opts, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ctrl.signal }); }
  finally { clearTimeout(timer); }
}

function errorPageHtml(status) {
  const timedOut = status === 504 || status === 408 || status === 0;
  const msg = timedOut
    ? 'The USPTO document service timed out while retrieving this file. This is usually temporary — please try again in a moment.'
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

  let url = `${DL_BASE}/${encodeURIComponent(appNum)}/${encodeURIComponent(documentId)}.${ext}`;
  const filename = `${appNum}-${documentId}.${ext}`;

  let lastStatus = 0;
  let lastDetail = '';
  let triedReal = false;
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    let upstream = null;
    try {
      upstream = await fetchHeaders(url, { headers: { 'X-API-KEY': apiKey } }, CONNECT_TIMEOUT_MS);
    } catch (err) {
      lastStatus = 504; // aborted / network error
      lastDetail = clientErrorDetail(err);
    }

    if (upstream && !upstream.ok) {
      lastStatus = upstream.status;
      lastDetail = (await upstream.text().catch(() => '')).slice(0, 200);
    }

    if (!upstream || !upstream.ok) {
      // The constructed URL may be wrong for this doc — resolve its real download
      // URL from metadata (once) and try that before giving up / retrying.
      if (!triedReal) {
        triedReal = true;
        const real = await resolveRealUrl(appNum, documentId, format, apiKey);
        if (real && real !== url) { url = real; continue; }
      }
      if (upstream && upstream.status < 500 && upstream.status !== 408) break; // 4xx won't change on retry
      continue; // retry 5xx/408/network
    }

    // Success — set headers and stream the body straight through.
    if (inline) {
      const upstreamType = upstream.headers.get('content-type') || '';
      const isGeneric = !upstreamType || /octet-stream|force-download|application\/download/i.test(upstreamType);
      res.setHeader('Content-Type', (isGeneric ? CTYPE[ext] : upstreamType) || CTYPE[ext] || 'application/octet-stream');
      res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    } else {
      res.setHeader('Content-Type', upstream.headers.get('content-type') || CTYPE[ext] || 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    }
    const len = upstream.headers.get('content-length');
    if (len) res.setHeader('Content-Length', len);
    // Documents are immutable, so cache aggressively in the browser and Vercel's
    // edge CDN — repeat views return instantly without re-hitting USPTO.
    res.setHeader('Cache-Control', 'public, max-age=31536000, s-maxage=31536000, immutable');
    res.statusCode = 200;

    if (!upstream.body) { // no streamable body — fall back to buffering
      res.end(Buffer.from(await upstream.arrayBuffer()));
      return;
    }
    const nodeStream = Readable.fromWeb(upstream.body);
    nodeStream.on('error', () => { try { res.end(); } catch { /* already closed */ } });
    nodeStream.pipe(res);
    return;
  }

  // All attempts failed before any bytes were sent. Never cache a failure so a
  // later retry can succeed.
  res.setHeader('Cache-Control', 'no-store');
  if (inline) {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(errorPageHtml(lastStatus));
  } else {
    res.status(502).json({ error: `Download failed: HTTP ${lastStatus}`, detail: lastDetail });
  }
}
