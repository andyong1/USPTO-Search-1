// PTAB AIA-trial Final Written Decision (FWD) helpers, built on the USPTO ODP
// "Search Decisions" endpoint. A discretionary denial happens at institution, so
// any proceeding with an FWD is by definition past the DD stage.
//
// The decisions endpoint's documentOCRText is only a ~500-char cover-page snippet
// (insufficient — the disposition is in the body/ORDER), so classification pulls
// the actual FWD PDF and extracts the caption + order pages' text.

import { getApiKey } from './uspto.js';
import { PDFDocument } from 'pdf-lib';
import pdfParse from 'pdf-parse/lib/pdf-parse.js';
import { ocrTextOfBuffer, ocrTextConfigured } from './ocr.js';
import { classifyFwd, detectDdDecision } from './ptab-classify.js';

// Re-export the pure classifier/detector so callers can import everything from lib/ptab.js.
export { classifyFwd, detectDdDecision, CLASSIFIER_V, FWD_OUTCOMES, DD_CHECK_V, DD_CUTOFF } from './ptab-classify.js';

const BASE = 'https://api.uspto.gov/api/v1/patent';

// ── Metadata catalog (fast) ────────────────────────────────────────
async function postDecisions(body, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(`${BASE}/trials/decisions/search`, {
      method: 'POST',
      headers: { 'X-API-KEY': getApiKey(), 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (e) {
    throw new Error(`PTAB decisions fetch failed: ${e.name === 'AbortError' ? 'timed out' : e.message}`);
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const t = await res.text();
    const err = new Error(`PTAB decisions fetch failed: HTTP ${res.status} ${t.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

// One page (max 100) of FWD metadata in a date window. Classification is done
// separately from the PDF (the search response's OCR text is only a snippet).
export async function fetchFwdPage({ types = [], from, to, offset = 0, limit = 100, timeoutMs = 25000 }) {
  const rangeFilters = [{ field: 'decisionData.decisionIssueDate', valueFrom: from || '2000-01-01', valueTo: to || '2100-01-01' }];
  const sort = [{ field: 'decisionData.decisionIssueDate', order: 'Desc' }];
  const qParts = ['decisionData.trialOutcomeCategory:"Final Written Decision"'];
  if (types.length) qParts.push('trialMetaData.trialTypeCode:(' + types.join(' OR ') + ')');

  let data;
  try {
    data = await postDecisions({ q: qParts.join(' AND '), rangeFilters, sort, pagination: { offset, limit } }, timeoutMs);
  } catch (e) {
    if (e.status === 400) data = await postDecisions({ rangeFilters, sort, pagination: { offset, limit } }, timeoutMs);
    else throw e;
  }

  const recs = data.patentTrialDocumentDataBag || [];
  const typeSet = new Set(types);
  const rows = [];
  for (const r of recs) {
    const dd = r.decisionData || {}, tm = r.trialMetaData || {}, doc = r.documentData || {};
    if (String(dd.trialOutcomeCategory || '') !== 'Final Written Decision') continue;
    if (typeSet.size && !typeSet.has(tm.trialTypeCode)) continue;
    if (!r.trialNumber) continue;
    const po = r.patentOwnerData || {}, pet = r.regularPetitionerData || {};
    rows.push({
      trial_number: r.trialNumber,
      trial_type: tm.trialTypeCode || '',
      patent_number: po.patentNumber || '',
      application_number: po.applicationNumberText || '',
      tech_center: po.technologyCenterNumber || '',
      group_art_unit: po.groupArtUnitNumber || '',
      po_name: po.realPartyInInterestName || '',
      petitioner_name: pet.realPartyInInterestName || '',
      po_counsel: po.counselName || '',
      petitioner_counsel: pet.counselName || '',
      petition_date: tm.petitionFilingDate || '',
      institution_date: tm.institutionDecisionDate || '',
      fwd_date: dd.decisionIssueDate || doc.documentFilingDate || '',
      fwd_doc_id: doc.documentIdentifier || '',
      fwd_pdf_url: doc.fileDownloadURI || '',
    });
  }
  return { count: data.count ?? null, fetched: recs.length, rows };
}

// ── FWD PDF text extraction + classification ────────────────────────
async function fetchPdfBuffer(pdfUrl, timeoutMs = 25000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try { res = await fetch(pdfUrl, { headers: { 'X-API-KEY': getApiKey() }, signal: controller.signal }); }
  catch (e) { throw new Error(`FWD PDF fetch failed: ${e.name === 'AbortError' ? 'timed out' : e.message}`); }
  finally { clearTimeout(timer); }
  if (!res.ok) throw new Error(`FWD PDF fetch failed: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
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

// Fetch the FWD PDF, extract text (born-digital text layer; OCR fallback for
// image-only), and classify. Returns { outcome, detail, source }.
export async function classifyFwdFromPdf(pdfUrl) {
  if (!pdfUrl) return { outcome: 'other', detail: 'no pdf url', source: 'none' };
  const buffer = await fetchPdfBuffer(pdfUrl);
  let text = '', source = 'pdf';
  try { text = await keyPagesText(buffer); }
  catch { try { text = (await pdfParse(buffer)).text || ''; } catch { text = ''; } }
  if (text.trim().length < 300 && ocrTextConfigured()) {
    try { const o = await ocrTextOfBuffer(buffer, 2); if (o && o.trim().length > text.trim().length) { text = o; source = 'ocr'; } }
    catch { /* keep whatever text we have */ }
  }
  const { outcome, detail } = classifyFwd(text);
  return { outcome, detail, source: text.trim().length ? source : 'none' };
}

// ── Director discretionary decision (bifurcated DD process) ─────────
async function postDocuments(body, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(`${BASE}/trials/documents/search`, {
      method: 'POST',
      headers: { 'X-API-KEY': getApiKey(), 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (e) { throw new Error(`PTAB documents fetch failed: ${e.name === 'AbortError' ? 'timed out' : e.message}`); }
  finally { clearTimeout(timer); }
  if (!res.ok) throw new Error(`PTAB documents fetch failed: HTTP ${res.status}`);
  return res.json();
}

// A proceeding's document type-descriptions + titles, oldest first (the DD
// decision sits early in the docket). Scoped via the `filters` mechanism —
// `q:"trialNumber:…"` does NOT scope on this endpoint.
export async function fetchTrialDocuments(trial, maxPages = 4, timeoutMs = 20000) {
  const out = [];
  for (let page = 0; page < maxPages; page++) {
    const data = await postDocuments({
      filters: [{ name: 'trialNumber', value: [trial] }],
      sort: [{ field: 'documentData.documentFilingDate', order: 'Asc' }],
      pagination: { offset: page * 100, limit: 100 },
    }, timeoutMs);
    const recs = data.patentTrialDocumentDataBag || [];
    for (const r of recs) { const d = r.documentData || {}; out.push({ typeDesc: d.documentTypeDescriptionText || '', title: d.documentTitleText || '' }); }
    if (recs.length < 100) break;
  }
  return out;
}

// Fetch a trial's docs and return its Director-discretionary-decision subtype
// ('refer'/'deny'/… or 'none').
export async function fetchDdDecision(trial) {
  const docs = await fetchTrialDocuments(trial);
  return detectDdDecision(docs);
}
