// PTAB AIA-trial Final Written Decision (FWD) helpers, built on the USPTO ODP
// "Search Decisions" endpoint (POST /trials/decisions/search). A discretionary
// denial happens at institution, so any proceeding with an FWD is by definition
// past the DD stage. We classify each FWD's result from the Board's standardized
// caption, which the API returns as documentOCRText.

import { getApiKey } from './uspto.js';

const BASE = 'https://api.uspto.gov/api/v1/patent';

// Outcome buckets:
//   petitioner_all — "Determining All Challenged Claims Unpatentable" (petitioner total win)
//   po_none        — "Determining No Challenged Claims Unpatentable" (patent owner total win)
//   partial        — "Determining Some Challenged Claims Unpatentable [and Some Not]"
//   other          — non-standard caption (e.g. adverse judgment, unusual disposition) → review
export const FWD_OUTCOMES = ['petitioner_all', 'partial', 'po_none', 'other'];

// Classify an FWD from its text. PTAB FWDs carry a standardized caption
// "Final Written Decision Determining {All|No|Some} ... Challenged Claims
// [Unpatentable]" (sometimes prefixed "Judgment"). We match that first, then a
// couple of body-text fallbacks, else 'other'.
export function classifyFwd(text) {
  const t = String(text || '').replace(/\s+/g, ' ');
  const m = t.match(/Determining\s+(All|No|Some)\s+(?:of\s+the\s+)?Challenged\s+Claims/i);
  if (m) {
    const w = m[1].toLowerCase();
    const outcome = w === 'all' ? 'petitioner_all' : w === 'no' ? 'po_none' : 'partial';
    return { outcome, detail: m[0].trim() };
  }
  // Fallbacks on the disposition sentence when the caption isn't in the captured text.
  if (/\ball\s+(?:of\s+the\s+)?challenged\s+claims[^.]{0,80}\bunpatentable\b/i.test(t)) return { outcome: 'petitioner_all', detail: 'all challenged claims unpatentable' };
  if (/\bno\s+challenged\s+claims[^.]{0,80}\bunpatentable\b/i.test(t)) return { outcome: 'po_none', detail: 'no challenged claims unpatentable' };
  if (/\bsome\s+(?:of\s+the\s+)?challenged\s+claims[^.]{0,80}\bunpatentable\b/i.test(t)) return { outcome: 'partial', detail: 'some challenged claims unpatentable' };
  return { outcome: 'other', detail: '' };
}

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

// Fetch one page (max 100) of Final Written Decisions in a date window, classify
// each, and return normalized rows. Filters to FWDs + the requested trial types
// server-side via `q`; if the endpoint rejects the query it falls back to a
// date-only fetch and filters client-side (correctness preserved, more volume).
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
    if (String(dd.trialOutcomeCategory || '') !== 'Final Written Decision') continue; // ensure FWD even if q was ignored
    if (typeSet.size && !typeSet.has(tm.trialTypeCode)) continue;
    const po = r.patentOwnerData || {}, pet = r.regularPetitionerData || {};
    const { outcome, detail } = classifyFwd(doc.documentOCRText || doc.documentTitleText || '');
    if (!r.trialNumber) continue;
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
      outcome,
      outcome_detail: detail,
      fwd_doc_id: doc.documentIdentifier || '',
      fwd_pdf_url: doc.fileDownloadURI || '',
    });
  }
  return { count: data.count ?? null, fetched: recs.length, rows };
}
