// PTAB FWD PDF text extraction (born-digital text layer; OCR fallback for image-
// only decisions). This module imports the heavy PDF stack (pdf-lib / pdf-parse)
// plus OCR, so only routes that actually extract text should import it. The
// metadata fetch/list helpers live in ./ptab-fetch.js and are re-exported here so
// existing `lib/ptab.js` importers keep working — but callers that need only
// metadata (e.g. the reexam-scan cron) should import ./ptab-fetch.js directly to
// keep the PDF stack out of their serverless bundle.

import { getApiKey } from './uspto.js';
import { PDFDocument } from 'pdf-lib';
import pdfParse from 'pdf-parse/lib/pdf-parse.js';
import { ocrTextOfBuffer, ocrTextConfigured } from './ocr.js';

// Re-export the metadata/list helpers (and the pure classifier symbols) so
// `import { ... } from '../lib/ptab.js'` continues to resolve everything.
export * from './ptab-fetch.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── FWD PDF text extraction ─────────────────────────────────────────
// Retry+backoff — the USPTO file endpoint returns transient 404/429/5xx under
// load, which would otherwise store an empty/error row and mis-classify a real
// FWD as 'other'. Only a persistent failure throws.
async function fetchPdfBuffer(pdfUrl, timeoutMs = 25000, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try { res = await fetch(pdfUrl, { headers: { 'X-API-KEY': getApiKey() }, signal: controller.signal }); }
    catch (e) {
      lastErr = new Error(`FWD PDF fetch failed: ${e.name === 'AbortError' ? 'timed out' : e.message}`);
      clearTimeout(timer);
      if (i < attempts - 1) { await sleep(600 * (i + 1)); continue; }
      throw lastErr;
    }
    clearTimeout(timer);
    if (res.ok) return Buffer.from(await res.arrayBuffer());
    lastErr = new Error(`FWD PDF fetch failed: HTTP ${res.status}`); lastErr.status = res.status;
    if ((res.status === 404 || res.status === 429 || res.status >= 500) && i < attempts - 1) { await sleep(600 * (i + 1)); continue; }
    throw lastErr;
  }
  throw lastErr;
}

// Text of just the caption (first 2) + order/conclusion (last 3) pages — enough
// to classify and far faster than parsing the whole decision.
async function keyPagesText(buffer) {
  const src = await PDFDocument.load(buffer, { ignoreEncryption: true });
  const n = src.getPageCount();
  const idx = [...new Set([0, 1, n - 3, n - 2, n - 1].filter((i) => i >= 0 && i < n))].sort((a, b) => a - b);
  const out = await PDFDocument.create();
  (await out.copyPages(src, idx)).forEach((p) => out.addPage(p));
  const data = await pdfParse(Buffer.from(await out.save()));
  return data.text || '';
}

// Fetch the FWD PDF and extract its text (born-digital text layer; OCR fallback
// for image-only). Returns { text, source }. The text is stored per row so the
// classifier can be re-run offline without re-fetching. Bump EXTRACT_V only when
// this extraction logic changes.
export const EXTRACT_V = 1;
export async function extractFwdText(pdfUrl) {
  if (!pdfUrl) return { text: '', source: 'none' };
  const buffer = await fetchPdfBuffer(pdfUrl);
  let text = '', source = 'pdf';
  try { text = await keyPagesText(buffer); }
  catch { try { text = (await pdfParse(buffer)).text || ''; } catch { text = ''; } }
  if (text.trim().length < 300 && ocrTextConfigured()) {
    try { const o = await ocrTextOfBuffer(buffer, 2); if (o && o.trim().length > text.trim().length) { text = o; source = 'ocr'; } }
    catch { /* keep whatever text we have */ }
  }
  return { text: text || '', source: text.trim().length ? source : 'none' };
}

// Full text of a born-digital document (e.g. an IPR petition), where the content
// we need is spread throughout — so unlike extractFwdText we parse ALL pages, not
// just the caption/order. No OCR fallback: petitions are text-layer PDFs, and
// OCR'ing 60-80 pages per trial is not worth it. Returns '' on failure.
export async function extractDocFullText(pdfUrl, timeoutMs = 25000) {
  if (!pdfUrl) return '';
  const buffer = await fetchPdfBuffer(pdfUrl, timeoutMs);
  try { return (await pdfParse(buffer)).text || ''; } catch { return ''; }
}
