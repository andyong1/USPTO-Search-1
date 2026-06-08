// Streams an application document (PDF/XML/DOCX) through the proxy, injecting the
// API key. The browser can't hit the USPTO download URL directly because it needs
// the X-API-KEY header. The upstream host is hard-coded (no open-proxy / SSRF risk).
//   GET /api/document?appNum=16123456&documentId=KEEQMGWJLDFLYX4&format=PDF
//
// disposition=inline  → render in the browser/iframe (forces the real content-type,
//                       since USPTO often returns application/octet-stream which
//                       browsers would otherwise download).
// disposition=attachment (default) → force a download.

export const config = { maxDuration: 60 };

const DL_BASE = 'https://api.uspto.gov/api/v1/download/applications';

const EXT = { PDF: 'pdf', XML: 'xml', 'MS WORD': 'docx', DOCX: 'docx', DOC: 'docx' };
const CTYPE = { pdf: 'application/pdf', xml: 'application/xml', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };

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

  try {
    const upstream = await fetch(url, { headers: { 'X-API-KEY': apiKey } });
    if (!upstream.ok) {
      const t = await upstream.text();
      res.status(upstream.status).json({ error: `Download failed: HTTP ${upstream.status}`, detail: t.slice(0, 200) });
      return;
    }
    const buf = Buffer.from(await upstream.arrayBuffer());
    const filename = `${appNum}-${documentId}.${ext}`;

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
  } catch (err) {
    res.status(502).json({ error: 'Document proxy failed.', detail: String(err.message || err) });
  }
}
