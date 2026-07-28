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

// ── EDIS (USITC Section 337) download proxy ────────────────────────────
// Streams a public EDIS document attachment through this function using a
// Login.gov Bearer token (EDIS_TOKEN) so /itc-investigation download links stay
// on-site. The attachment LIST is anonymous; only the file stream needs the
// token. Mirror-ready: the detail page prefers a Blob mirror_url and only falls
// back to this proxy. EDIS tokens expire (Login.gov, no programmatic refresh),
// so a 401/403 here means the server token must be refreshed.
//   GET /api/document?itcdl=<docId>[&att=<attachmentId>][&inline=1]
const EDIS = 'https://edis.usitc.gov/data';
const XENT = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" };
const xdecode = (s) => s == null ? null : s
  .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
  .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
  .replace(/&(amp|lt|gt|quot|apos);/g, (m) => XENT[m]);

function parseAttachments(xml) {
  const out = [];
  const re = /<attachment>([\s\S]*?)<\/attachment>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const b = m[1];
    const g = (t) => { const mm = b.match(new RegExp(`<${t}>([\\s\\S]*?)</${t}>`)); return mm ? xdecode(mm[1].trim()) : null; };
    out.push({ id: (g('id') || '').replace(/[^0-9]/g, ''), title: g('title'), fileSize: g('fileSize'), pageCount: g('pageCount') });
  }
  return out.filter((a) => a.id);
}

function itcNoticeHtml(msg) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" /><title>Document unavailable</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#525659;color:#e2e8f0;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;padding:24px}.box{max-width:460px;text-align:center;line-height:1.55}h1{font-size:1.1rem;margin:0 0 10px;color:#fff}p{font-size:.95rem;margin:0;color:#cbd5e0}</style></head><body>
  <div class="box"><h1>Document unavailable</h1><p>${msg}</p></div></body></html>`;
}

// On-site picker for a document with several attachments — plain View/Download
// links per file, so the detail page can use simple anchors (no client JS).
function itcPickerHtml(docId, attachments) {
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const items = attachments.map((a) => {
    const kb = a.fileSize ? ` · ${Math.round(Number(a.fileSize) / 1024)} KB` : '';
    const pg = a.pageCount ? ` · ${a.pageCount} pp` : '';
    return `<li><span class="t">${esc(a.title || ('Attachment ' + a.id))}${kb}${pg}</span>
      <a href="/api/document?itcdl=${docId}&att=${a.id}&inline=1" target="_blank" rel="noopener">View</a>
      <a href="/api/document?itcdl=${docId}&att=${a.id}">Download</a></li>`;
  }).join('');
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" /><title>Document attachments</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#f7fafc;color:#1a202c;margin:0;padding:28px}h1{font-size:1.05rem;margin:0 0 14px}ul{list-style:none;padding:0;margin:0;max-width:760px}li{padding:12px 14px;border:1px solid #e2e8f0;border-radius:8px;background:#fff;margin-bottom:10px;display:flex;align-items:center;gap:14px;flex-wrap:wrap}.t{flex:1;min-width:220px}a{color:#1a3a6b;font-weight:600;text-decoration:none}a:hover{text-decoration:underline}</style></head><body>
  <h1>This document has ${attachments.length} attachments</h1><ul>${items}</ul></body></html>`;
}

async function itcDownload(req, res) {
  const token = process.env.EDIS_TOKEN;
  const docId = String(req.query.itcdl || '').replace(/[^0-9]/g, '');
  const attId = String(req.query.att || '').replace(/[^0-9]/g, '');
  const inline = String(req.query.inline || '') === '1';
  // Error responder: a friendly HTML notice for View (inline) tabs, JSON otherwise.
  const fail = (status, msg) => {
    res.setHeader('Cache-Control', 'no-store');
    if (inline) { res.statusCode = 200; res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(itcNoticeHtml(msg)); }
    else res.status(status).json({ error: msg });
  };
  if (!docId) { res.status(400).json({ error: 'itcdl (document id) is required.' }); return; }

  // 1) Resolve the document's attachment(s) — anonymous, no token needed.
  let attachments;
  try {
    const r = await fetchHeaders(`${EDIS}/attachment/${docId}`, { headers: { Accept: 'application/xml' } }, 15000);
    const xml = await r.text();
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    attachments = parseAttachments(xml);
  } catch (e) { fail(502, `Could not resolve EDIS attachments (${clientErrorDetail(e)}).`); return; }
  if (!attachments.length) { fail(404, 'No attachments were found for this document.'); return; }

  // Pick one: explicit att param, or the sole attachment. If several and none
  // chosen, serve an on-site picker page with View + Download per attachment.
  const chosen = attId ? attachments.find((a) => a.id === attId) : (attachments.length === 1 ? attachments[0] : null);
  if (!chosen) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.status(200).send(itcPickerHtml(docId, attachments));
    return;
  }

  // 2) Stream the file with the Bearer token.
  if (!token) { fail(503, 'EDIS downloads are unavailable right now (the server access token is not configured).'); return; }
  let up = null;
  try { up = await fetchHeaders(`${EDIS}/download/${docId}/${chosen.id}`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/pdf' } }, CONNECT_TIMEOUT_MS); }
  catch (e) { fail(504, `The EDIS download timed out (${clientErrorDetail(e)}).`); return; }
  if (up.status === 401 || up.status === 403) { fail(502, 'EDIS authorization failed — the server access token has likely expired and needs to be refreshed.'); return; }
  if (!up.ok) { fail(502, `EDIS download failed (HTTP ${up.status}).`); return; }

  const base = (chosen.title || `edis-${docId}-${chosen.id}`).replace(/[^A-Za-z0-9._ -]/g, '_').slice(0, 120) || `edis-${docId}`;
  const fname = /\.pdf$/i.test(base) ? base : `${base}.pdf`;
  res.setHeader('Content-Type', up.headers.get('content-type') || 'application/pdf');
  res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${fname}"`);
  const len = up.headers.get('content-length'); if (len) res.setHeader('Content-Length', len);
  // Public EDIS documents are immutable — cache at the edge so repeat downloads
  // don't re-hit EDIS or re-spend the token.
  res.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=604800');
  res.statusCode = 200;
  if (!up.body) { res.end(Buffer.from(await up.arrayBuffer())); return; }
  const ns = Readable.fromWeb(up.body);
  ns.on('error', () => { try { res.end(); } catch { /* already closed */ } });
  ns.pipe(res);
}

export default async function handler(req, res) {
  // EDIS Section 337 download proxy (independent of the USPTO key path below).
  if (req.query.itcdl) { await itcDownload(req, res); return; }

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
