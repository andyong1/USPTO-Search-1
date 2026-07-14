// PTAB metadata fetch/list helpers (USPTO ODP decisions / documents / proceedings
// + applications search). Deliberately free of pdf-lib / pdf-parse / OCR so callers
// that only need metadata — e.g. the reexam-scan cron's daily digest + filing
// counts — don't pull the heavy PDF stack into their serverless bundle. FWD PDF
// text extraction lives in ./ptab.js (which re-exports everything here).

import { getApiKey, searchApplications } from './uspto.js';
import { detectDdDecision } from './ptab-classify.js';

// Re-export the pure classifier/detector so callers can import them from here too.
export { classifyFwd, detectDdDecision, CLASSIFIER_V, FWD_OUTCOMES, DD_CHECK_V, DD_CUTOFF } from './ptab-classify.js';

const BASE = 'https://api.uspto.gov/api/v1/patent';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

// ── Director discretionary decision (bifurcated DD process) ─────────
// POST the documents/search endpoint with retry+backoff. The USPTO API returns
// spurious 404s (and 429/5xx) under load — retrying avoids poisoning a row's DD
// flag or blanking a docket on a transient blip. Only a persistent failure throws.
async function postDocuments(body, timeoutMs, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
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
    } catch (e) {
      lastErr = new Error(`PTAB documents fetch failed: ${e.name === 'AbortError' ? 'timed out' : e.message}`);
      clearTimeout(timer);
      if (i < attempts - 1) { await sleep(600 * (i + 1)); continue; }
      throw lastErr;
    }
    clearTimeout(timer);
    if (res.ok) return res.json();
    lastErr = new Error(`PTAB documents fetch failed: HTTP ${res.status}`); lastErr.status = res.status;
    // 404/429/5xx are transient on this API — retry; other statuses fail fast.
    if ((res.status === 404 || res.status === 429 || res.status >= 500) && i < attempts - 1) { await sleep(600 * (i + 1)); continue; }
    throw lastErr;
  }
  throw lastErr;
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

// ── Discretion / institution decisions enumeration (for the /ptab-decisions page) ──
// Both institution and Director-discretionary decisions are enumerated site-wide
// from the documents feed by a documentTypeDescriptionText q + a filing-date range.
// The grant/deny and deny/refer values are in the metadata — no PDF needed.
function mapDecisionRec(r) {
  const tm = r.trialMetaData || {}, po = r.patentOwnerData || {}, pet = r.regularPetitionerData || {}, doc = r.documentData || {};
  return {
    trial_number: r.trialNumber || '',
    trial_type: tm.trialTypeCode || '',
    patent_number: po.patentNumber || '',
    application_number: po.applicationNumberText || '',
    tech_center: po.technologyCenterNumber || '',
    group_art_unit: po.groupArtUnitNumber || '',
    po_name: po.realPartyInInterestName || '',
    petitioner_name: pet.realPartyInInterestName || '',
    petition_date: tm.petitionFilingDate || '',
    institution_date: tm.institutionDecisionDate || '',
    docType: doc.documentTypeDescriptionText || '',
    date: doc.documentFilingDate || '',
    docId: doc.documentIdentifier || '',
    pdfUrl: doc.fileDownloadURI || '',
  };
}
async function fetchDocDecisionPage({ q, from, to, offset = 0, limit = 100, timeoutMs = 25000 }) {
  const data = await postDocuments({
    q,
    rangeFilters: [{ field: 'documentData.documentFilingDate', valueFrom: from || '2024-01-01', valueTo: to || '2100-01-01' }],
    sort: [{ field: 'documentData.documentFilingDate', order: 'Desc' }],
    pagination: { offset, limit },
  }, timeoutMs);
  const recs = data.patentTrialDocumentDataBag || [];
  return { count: data.count ?? null, fetched: recs.length, recs };
}
// One page of institution decisions (Institution Decision: Grant/Deny).
export async function fetchInstitutionPage({ from, to, offset = 0, limit = 100 } = {}) {
  const { count, fetched, recs } = await fetchDocDecisionPage({ q: 'documentData.documentTypeDescriptionText:"Institution Decision"', from, to, offset, limit });
  const rows = [];
  for (const r of recs) {
    const m = mapDecisionRec(r);
    if (!m.trial_number || !/^Institution\s+Decision/i.test(m.docType)) continue;
    const inst_type = /grant/i.test(m.docType) ? 'granted' : (/den(y|ied|ial)/i.test(m.docType) ? 'denied' : 'other');
    rows.push({ ...m, inst_type, inst_date: m.date, inst_doc_id: m.docId, inst_pdf_url: m.pdfUrl });
  }
  return { count, fetched, rows };
}
// One page of Director discretionary decisions (Director Discretionary Decision: Deny/Refer).
export async function fetchDdPage({ from, to, offset = 0, limit = 100 } = {}) {
  const { count, fetched, recs } = await fetchDocDecisionPage({ q: 'documentData.documentTypeDescriptionText:"Director Discretionary Decision"', from, to, offset, limit });
  const rows = [];
  for (const r of recs) {
    const m = mapDecisionRec(r);
    if (!m.trial_number || !/Director\s+Discretionary\s+Decision/i.test(m.docType)) continue;
    const mm = m.docType.match(/Director\s+Discretionary\s+Decision\s*:?\s*([A-Za-z]+)/i);
    rows.push({ ...m, dd_type: mm ? mm[1].toLowerCase() : 'other', dd_date: m.date, dd_doc_id: m.docId, dd_pdf_url: m.pdfUrl });
  }
  return { count, fetched, rows };
}

// ── Monthly filing counts (for the filings-trends page) ─────────────
// Count of ex parte reexaminations (90/* applications) filed in a date window.
export async function fetchReexamFilingCount(from, to) {
  const data = await searchApplications({
    q: 'applicationNumberText:90*',
    rangeFilters: [{ field: 'applicationMetaData.filingDate', valueFrom: from, valueTo: to }],
    fields: ['applicationNumberText'],
    pagination: { offset: 0, limit: 1 },
  });
  return data.count ?? 0;
}
// Count of IPR petitions filed in a date window (one record per proceeding).
export async function fetchIprPetitionCount(from, to, timeoutMs = 25000) {
  for (let i = 0; i < 3; i++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(`${BASE}/trials/proceedings/search`, {
        method: 'POST',
        headers: { 'X-API-KEY': getApiKey(), 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          q: 'trialMetaData.trialTypeCode:IPR',
          rangeFilters: [{ field: 'trialMetaData.petitionFilingDate', valueFrom: from, valueTo: to }],
          pagination: { offset: 0, limit: 1 },
        }),
        signal: controller.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      if (i < 2) { await sleep(500 * (i + 1)); continue; }
      throw new Error(`PTAB proceedings fetch failed: ${e.name === 'AbortError' ? 'timed out' : e.message}`);
    }
    clearTimeout(timer);
    if (res.ok) { const d = await res.json(); return d.count ?? 0; }
    // The proceedings endpoint returns 404 (not count:0) when a query matches zero
    // records — i.e. no IPR petitions filed that day. Treat as a real zero.
    if (res.status === 404) return 0;
    if ((res.status === 429 || res.status >= 500) && i < 2) { await sleep(500 * (i + 1)); continue; }
    throw new Error(`PTAB proceedings fetch failed: HTTP ${res.status}`);
  }
  return 0;
}

// ── Full proceeding detail (for the /trial page) ────────────────────
// One filters-scoped documents/search (paginated), returning the trial's
// metadata/status plus the complete document docket. Live, on-demand.
export async function fetchTrialDetail(trial, maxPages = 6, timeoutMs = 20000) {
  const documents = [];
  let meta = null, count = null, docsUnavailable = false;
  for (let page = 0; page < maxPages; page++) {
    let data;
    try {
      data = await postDocuments({
        filters: [{ name: 'trialNumber', value: [trial] }],
        sort: [{ field: 'documentData.documentFilingDate', order: 'Asc' }],
        pagination: { offset: page * 100, limit: 100 },
      }, timeoutMs);
    } catch (e) {
      // A 404 means the documents index has no record for this trial — not a hard
      // failure. Return an empty docket so the page can fall back to stored data.
      if (e.status === 404) { docsUnavailable = page === 0; break; }
      throw e;
    }
    count = data.count ?? count;
    const recs = data.patentTrialDocumentDataBag || [];
    for (const r of recs) {
      if (!meta && (r.trialMetaData || r.patentOwnerData)) {
        const tm = r.trialMetaData || {}, po = r.patentOwnerData || {}, pet = r.regularPetitionerData || {};
        meta = {
          trialNumber: r.trialNumber || trial,
          trialType: tm.trialTypeCode || '',
          status: tm.trialStatusCategory || '',
          patentNumber: po.patentNumber || '',
          applicationNumber: po.applicationNumberText || '',
          techCenter: po.technologyCenterNumber || '',
          artUnit: po.groupArtUnitNumber || '',
          inventor: po.inventorName || '',
          grantDate: po.grantDate || '',
          poName: po.realPartyInInterestName || '',
          poCounsel: po.counselName || '',
          petitionerName: pet.realPartyInInterestName || '',
          petitionerCounsel: pet.counselName || '',
          petitionDate: tm.petitionFilingDate || tm.accordedFilingDate || '',
          institutionDate: tm.institutionDecisionDate || '',
          latestDecisionDate: tm.latestDecisionDate || '',
          lastModified: tm.trialLastModifiedDate || '',
        };
      }
      const d = r.documentData || {};
      documents.push({
        id: d.documentIdentifier || '',
        number: d.documentNumber ?? null,
        category: d.documentCategory || '',
        type: d.documentTypeDescriptionText || '',
        title: d.documentTitleText || d.documentName || '',
        name: d.documentName || '',
        filingDate: d.documentFilingDate || '',
        party: d.filingPartyCategory || '',
        sizeBytes: d.documentSizeQuantity ?? null,
        url: d.fileDownloadURI || '',
      });
    }
    if (recs.length < 100) break;
  }
  return { meta: meta || { trialNumber: trial }, documents, count: count ?? documents.length, docsUnavailable };
}
