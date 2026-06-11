// OCR pipeline for scanned petition-decision PDFs using OCR.space (free tier),
// storing the result as a searchable PDF in Vercel Blob. OCR.space is synchronous
// (one HTTP call per chunk), so no async job/state is needed.
//
// Free-tier limits: 1 MB per request and 3 pages per PDF — so we split the
// decision into <=3-page chunks (and oversized chunks into single pages), OCR
// each, then merge the per-chunk searchable PDFs back into one.

import { put } from '@vercel/blob';
import { PDFDocument } from 'pdf-lib';
import { fetchDocumentBytes } from './uspto.js';
import { detect325d } from './reexamOutcome.js';

const OCR_URL = 'https://api.ocr.space/parse/image';
const MAX_PAGES_PER_CHUNK = 3;
const MAX_BYTES = 1024 * 1024; // 1 MB free-tier file limit

export function ocrConfigured() {
  return !!(process.env.OCR_SPACE_API_KEY && process.env.BLOB_READ_WRITE_TOKEN);
}
// Text-only OCR (no Blob storage) just needs the OCR.space key.
export function ocrTextConfigured() {
  return !!process.env.OCR_SPACE_API_KEY;
}

// Split a PDF buffer into chunks of at most maxPages pages each (as PDF byte arrays).
async function splitPdf(buffer, maxPages) {
  const src = await PDFDocument.load(buffer, { ignoreEncryption: true });
  const n = src.getPageCount();
  const chunks = [];
  for (let start = 0; start < n; start += maxPages) {
    const out = await PDFDocument.create();
    const idx = [];
    for (let i = start; i < Math.min(start + maxPages, n); i++) idx.push(i);
    const copied = await out.copyPages(src, idx);
    copied.forEach((p) => out.addPage(p));
    chunks.push(await out.save());
  }
  return chunks;
}

async function fetchWithTimeout(url, opts, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ctrl.signal }); }
  finally { clearTimeout(t); }
}

// One OCR.space call for a single PDF chunk → { text, searchablePdf|null }.
// wantSearchable=false skips building/fetching the searchable PDF (text only).
async function ocrChunk(bytes, wantSearchable = true, timeoutMs = 25000) {
  const form = new FormData();
  form.append('apikey', process.env.OCR_SPACE_API_KEY);
  form.append('filetype', 'PDF');
  form.append('isCreateSearchablePdf', wantSearchable ? 'true' : 'false');
  form.append('OCREngine', '1');
  form.append('file', new Blob([bytes], { type: 'application/pdf' }), 'doc.pdf');

  const res = await fetchWithTimeout(OCR_URL, { method: 'POST', body: form }, timeoutMs);
  if (!res.ok) throw new Error('OCR.space HTTP ' + res.status);
  const data = await res.json();
  if (data.IsErroredOnProcessing) {
    const m = Array.isArray(data.ErrorMessage) ? data.ErrorMessage.join('; ') : (data.ErrorMessage || 'unknown');
    throw new Error('OCR.space: ' + m);
  }
  const text = (data.ParsedResults || []).map((r) => r.ParsedText || '').join('\n');
  let searchablePdf = null;
  if (wantSearchable && data.SearchablePDFURL) {
    try { const r = await fetchWithTimeout(data.SearchablePDFURL, {}, 20000); if (r.ok) searchablePdf = Buffer.from(await r.arrayBuffer()); } catch { /* text-only */ }
  }
  return { text, searchablePdf };
}

// OCR a PDF buffer to plain text only (no Blob). Caps the number of chunks
// OCR'd (maxChunks × 3 pages) so one image-only document can't blow the 60s
// function limit — enough to catch a §325(d) citation in a petition's argument.
export async function ocrTextOfBuffer(buffer, maxChunks = 2, perChunkMs = 12000) {
  let chunks;
  try { chunks = await splitPdf(buffer, MAX_PAGES_PER_CHUNK); }
  catch { chunks = [buffer]; }
  const sized = [];
  for (const c of chunks) {
    if (c.length <= MAX_BYTES) { sized.push(c); continue; }
    try { (await splitPdf(c, 1)).forEach((s) => sized.push(s)); }
    catch { sized.push(c); }
  }
  let allText = '';
  const use = sized.slice(0, maxChunks);
  for (let i = 0; i < use.length; i++) {
    if (use[i].length > MAX_BYTES) continue;
    if (i > 0) await new Promise((r) => setTimeout(r, 1500)); // pace under OCR.space's per-minute limit
    const { text } = await ocrChunk(use[i], false, perChunkMs);
    allText += '\n' + (text || '');
  }
  return allText;
}

// Full OCR for one decision: download → chunk → OCR each → 325(d) detect → merge
// searchable PDFs → store in Blob. Returns { is325d, blobUrl }.
export async function ocrDecision(appNum, docId) {
  const { buffer } = await fetchDocumentBytes(appNum, docId, 'PDF');

  let chunks;
  try { chunks = await splitPdf(buffer, MAX_PAGES_PER_CHUNK); }
  catch { chunks = [buffer]; }

  // Re-split any chunk that's still over the size limit into single pages.
  const sized = [];
  for (const c of chunks) {
    if (c.length <= MAX_BYTES) { sized.push(c); continue; }
    try { (await splitPdf(c, 1)).forEach((s) => sized.push(s)); }
    catch { sized.push(c); }
  }

  let allText = '';
  const searchableParts = [];
  for (const c of sized) {
    if (c.length > MAX_BYTES) continue; // a single page still too big for the free tier
    const { text, searchablePdf } = await ocrChunk(c);
    allText += '\n' + (text || '');
    if (searchablePdf) searchableParts.push(searchablePdf);
  }

  const is325d = detect325d(allText);

  let blobUrl = null;
  if (searchableParts.length) {
    try {
      const merged = await PDFDocument.create();
      for (const part of searchableParts) {
        const pd = await PDFDocument.load(part, { ignoreEncryption: true });
        const pages = await merged.copyPages(pd, pd.getPageIndices());
        pages.forEach((p) => merged.addPage(p));
      }
      const out = await merged.save();
      const key = `reexam-ocr/${String(appNum).replace(/[^\w.-]/g, '_')}-${String(docId).replace(/[^\w.-]/g, '_')}-searchable.pdf`;
      const { url } = await put(key, out, { access: 'public', contentType: 'application/pdf', addRandomSuffix: false, allowOverwrite: true, cacheControlMaxAge: 31536000 });
      blobUrl = url;
    } catch { /* keep the 325(d) flag even if storing the PDF fails */ }
  }
  return { is325d, blobUrl };
}
