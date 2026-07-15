// Thin wrapper around the USPTO Open Data Portal API. Reads the key from the
// environment so it never reaches the browser.

const BASE = 'https://api.uspto.gov/api/v1/patent';

const parseISO = (s) => {
  const m = String(s || '').match(/(\d{4})-?(\d{2})-?(\d{2})/);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : NaN;
};

// Given a proceeding's documents and its pre-order submission date, find a
// requestor petition (RXPET*) filed within 20 days, and its decision (RXPTD*).
// Decision outcome is classified by code/description (granted code is unknown,
// so we rely on the description text: "dismiss" => dismissed, "grant" => granted).
export function analyzePetition(docs, preorderDate) {
  const pd = parseISO(preorderDate);
  let petition = null;
  if (!isNaN(pd)) {
    for (const d of docs) {
      if (!(d.documentCode || '').toUpperCase().startsWith('RXPET')) continue;
      const t = parseISO(d.officialDate);
      if (isNaN(t)) continue;
      if (Math.abs(t - pd) <= 20 * 86400000) {
        if (!petition || t < parseISO(petition.officialDate)) petition = d;
      }
    }
  }
  // Petition decision codes: RXPTGR = granted, RXPTDI = dismissed. Detected
  // independently of the requestor petition — the decision can post (e.g. a
  // dismissal) without a separately-coded RXPET* paper on file. Bounded to
  // on/after the pre-order submission so an unrelated earlier decision can't
  // attach.
  const DECISION = { RXPTGR: 'granted', RXPTDI: 'dismissed' };
  let decision = null;
  for (const d of docs) {
    if (!DECISION[(d.documentCode || '').toUpperCase()]) continue;
    const t = parseISO(d.officialDate);
    if (!isNaN(pd) && !isNaN(t) && t < pd) continue;
    if (!decision || parseISO(d.officialDate) < parseISO(decision.officialDate)) decision = d;
  }
  const outcome = decision ? DECISION[(decision.documentCode || '').toUpperCase()] : null;
  return {
    petition: petition ? { id: petition.documentIdentifier, date: petition.officialDate } : null,
    decision: decision ? { id: decision.documentIdentifier, date: decision.officialDate, outcome } : null,
  };
}

// Classify who requested an ex parte reexamination from its USPTO event/document
// codes. Verified against live records: the office records the request-type as a
// transaction event — RXOSUB.R "Reexamination requested by third party requester"
// (with length variants RXOSUB.R.40 / RXO_40.R), present in the /transactions
// feed for every third-party case even when the /documents feed lacks it. Other
// third-party-only papers (3rd-party IDS/affidavit, requestor petitions/replies,
// owner statement to order, patent-owner pre-order submission) corroborate it.
// `codes` is a flat list of code strings (union of document + transaction codes).
//   director     — Director-initiated (sua sponte) order, no party request
//   third_party  — any third-party-only code present
//   patent_owner — a request receipt (RXOSUB*) present with no third-party code
//   unknown      — no request/transaction/order codes at all
const DIRECTOR_PREFIXES = ['RXDOR']; // "Director Initiated Order for Reexam" — sua sponte, no requester
const TP_PREFIXES = [
  'RXOSUB.R', 'RXO_40.R', // request explicitly by third-party requester (+ <40pp variant)
  'RXIDS.R', 'RXAF/DR',   // IDS / affidavit filed BY third party requester (note: RXIDS. / RXAF/D are generic)
  'RXOPPPET', 'RX.PRO.PO', 'RXPET', 'RXRR', 'RXOR.', // requester opposition / PO pre-order / requestor petition / requestor reply / owner statement to order
  'RXC/SR', // certificate of service — only exists when there's another party to serve (i.e. a third-party requester)
];
export function classifyRequester(codes) {
  if (!Array.isArray(codes)) return 'unknown';
  const up = codes.map((c) => String(c || '').toUpperCase()).filter(Boolean);
  if (!up.length) return 'unknown';
  if (up.some((c) => DIRECTOR_PREFIXES.some((p) => c.startsWith(p)))) return 'director';
  if (up.some((c) => TP_PREFIXES.some((p) => c.startsWith(p)))) return 'third_party';
  if (up.some((c) => c.startsWith('RXOSUB'))) return 'patent_owner'; // request received, not flagged third-party
  return 'unknown';
}

// Best-effort list of an application's transaction (PALM event) codes, uppercased.
// Throws on network/HTTP error (so callers can retry); returns [] only when the
// response genuinely has no transaction array.
export async function fetchTransactions(appNum, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(
      `${BASE}/applications/${encodeURIComponent(appNum)}/transactions`,
      { headers: { 'X-API-KEY': getApiKey(), Accept: 'application/json' }, signal: controller.signal }
    );
  } catch (e) {
    throw new Error(`USPTO transactions fetch failed for ${appNum}: ${e.name === 'AbortError' ? 'timed out' : e.message}`);
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new Error(`USPTO transactions fetch failed for ${appNum}: HTTP ${res.status}`);
  const data = await res.json().catch(() => null);
  if (!data) return [];
  const rec = (Array.isArray(data.patentFileWrapperDataBag) && data.patentFileWrapperDataBag[0]) || data;
  const bag = rec.eventDataBag || rec.transactionContentBag || rec.transactions || data.eventDataBag || (Array.isArray(data) ? data : []);
  if (!Array.isArray(bag)) return [];
  return bag.map((t) => String(t.eventCode || t.transactionCode || t.code || '').toUpperCase()).filter(Boolean);
}

export function getApiKey() {
  const k = process.env.USPTO_API_KEY;
  if (!k) throw new Error('Missing USPTO_API_KEY environment variable.');
  return k;
}

// POST a search payload to the applications search endpoint. USPTO returns 404
// when nothing matches — normalize that to an empty result instead of throwing.
export async function searchApplications(body, timeoutMs = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(`${BASE}/applications/search`, {
      method: 'POST',
      headers: { 'X-API-KEY': getApiKey(), 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (e) {
    throw new Error(`USPTO search failed: ${e.name === 'AbortError' ? 'timed out' : e.message}`);
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 404) return { count: 0, patentFileWrapperDataBag: [] };
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`USPTO search failed: HTTP ${res.status} ${t.slice(0, 200)}`);
  }
  return res.json();
}

// Pre-order coverage denominators from the live USPTO index: total ex parte
// reexams filed on/after the cutoff, and how many of those have had their 30-day
// pre-order window elapse. The daily cron calls this to precompute the counts so
// the pre-order page doesn't issue these searches on every view.
export async function fetchPreorderCoverage(cutoff) {
  let totalFiled = null;
  try {
    const data = await searchApplications({
      q: 'applicationNumberText:90*',
      rangeFilters: [{ field: 'applicationMetaData.filingDate', valueFrom: cutoff, valueTo: '2100-01-01' }],
      pagination: { offset: 0, limit: 1 },
    });
    totalFiled = data.count ?? data.totalNumFound ?? null;
  } catch { /* leave null */ }

  let deadlinePassed = null;
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 30);
  const passedTo = d.toISOString().slice(0, 10);
  if (passedTo >= cutoff) {
    try {
      const data = await searchApplications({
        q: 'applicationNumberText:90*',
        rangeFilters: [{ field: 'applicationMetaData.filingDate', valueFrom: cutoff, valueTo: passedTo }],
        pagination: { offset: 0, limit: 1 },
      });
      deadlinePassed = data.count ?? data.totalNumFound ?? null;
    } catch { /* leave null */ }
  } else {
    deadlinePassed = 0; // still within 30 days of the cutoff
  }
  return { totalFiled, deadlinePassed };
}

// Fetch the document metadata for one application and normalize it to a flat shape.
// Uses a hard timeout so one slow/hung USPTO response can't stall the whole job.
export async function fetchDocuments(appNum, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(
      `${BASE}/applications/${encodeURIComponent(appNum)}/documents`,
      { headers: { 'X-API-KEY': getApiKey(), Accept: 'application/json' }, signal: controller.signal }
    );
  } catch (e) {
    throw new Error(`USPTO documents fetch failed for ${appNum}: ${e.name === 'AbortError' ? 'timed out' : e.message}`);
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`USPTO documents fetch failed for ${appNum}: HTTP ${res.status} ${t.slice(0, 200)}`);
  }
  const data = await res.json();
  const bag = data.documentBag || data.documents || (Array.isArray(data) ? data : []);

  return bag
    .map((d) => ({
      documentIdentifier: d.documentIdentifier || d.documentId || '',
      documentCode: d.documentCode || '',
      description: d.documentCodeDescriptionText || d.documentDescriptionText || '',
      officialDate: d.officialDate || d.officialDateTime || d.mailRoomDate || '',
      direction: d.directionCategory || '',
      pageCount: d.pageTotalQuantity || d.pageCount || null,
      formats: (d.downloadOptionBag || d.downloadOptions || [])
        .map((o) => o.mimeTypeIdentifier || o.mimeType || '')
        .filter(Boolean),
      // Real per-format download URLs from the metadata. Some documents (e.g.
      // certain petitions) live at a nested .../files/{fileId}.pdf path that
      // differs from the constructed {docId}.{ext} URL, so prefer these.
      downloads: (d.downloadOptionBag || d.downloadOptions || [])
        .map((o) => ({ mime: o.mimeTypeIdentifier || o.mimeType || '', url: o.downloadUrl || o.url || '' }))
        .filter((o) => o.mime && o.url),
    }))
    .filter((d) => d.documentIdentifier);
}

// Download the raw bytes of a single document. Returns { buffer, contentType }.
const DL_BASE = 'https://api.uspto.gov/api/v1/download/applications';
const DOC_EXT = { PDF: 'pdf', XML: 'xml', 'MS WORD': 'docx', DOCX: 'docx', DOC: 'docx' };
export async function fetchDocumentBytes(appNum, documentId, format = 'PDF', timeoutMs = 25000) {
  const ext = DOC_EXT[String(format).toUpperCase()] || 'pdf';
  const want = String(format).toUpperCase();
  const constructed = `${DL_BASE}/${encodeURIComponent(appNum)}/${encodeURIComponent(documentId)}.${ext}`;

  const download = async (url) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { headers: { 'X-API-KEY': getApiKey() }, signal: controller.signal });
    } catch (e) {
      throw new Error(`USPTO document download failed for ${appNum}/${documentId}: ${e.name === 'AbortError' ? 'timed out' : e.message}`);
    } finally {
      clearTimeout(timer);
    }
  };

  // Try the constructed {docId}.{ext} URL first — correct for the vast majority of
  // documents, so no extra listing fetch. Only if it 4xx's (e.g. documents whose
  // real URL is a nested .../files/{fileId}.{ext} path, like some petitions) do we
  // fetch the document list to resolve the real download URL and retry.
  let res = await download(constructed);
  if (!res.ok && res.status >= 400 && res.status < 500) {
    try {
      const docs = await fetchDocuments(appNum, Math.min(timeoutMs, 10000));
      const doc = docs.find((d) => d.documentIdentifier === documentId);
      const opt = doc && (doc.downloads || []).find((o) => want === 'PDF' ? /pdf/i.test(o.mime) : String(o.mime).toUpperCase().includes(want));
      if (opt && opt.url && opt.url !== constructed) res = await download(opt.url);
    } catch { /* keep the original response */ }
  }
  if (!res.ok) throw new Error(`USPTO document download failed for ${appNum}/${documentId}: HTTP ${res.status}`);
  return { buffer: Buffer.from(await res.arrayBuffer()), contentType: res.headers.get('content-type') || '' };
}

// Fetch an application's continuity record (parent/child relationships).
// Returns the first wrapper record, or null on failure (best-effort).
export async function fetchContinuity(appNum, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(
      `${BASE}/applications/${encodeURIComponent(appNum)}/continuity`,
      { headers: { 'X-API-KEY': getApiKey(), Accept: 'application/json' }, signal: controller.signal }
    );
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) return null;
  const data = await res.json().catch(() => null);
  if (!data) return null;
  return (Array.isArray(data.patentFileWrapperDataBag) && data.patentFileWrapperDataBag[0]) || data;
}

// Fetch an application's bibliographic metadata and pull out group art unit and
// examiner. Uses the full-record endpoint (same source as the lookup Overview,
// which reliably has these fields). Returns {} on failure (best-effort).
export async function fetchMetaData(appNum, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(
      `${BASE}/applications/${encodeURIComponent(appNum)}`,
      { headers: { 'X-API-KEY': getApiKey(), Accept: 'application/json' }, signal: controller.signal }
    );
  } catch {
    return {};
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) return {};
  const data = await res.json().catch(() => ({}));
  const rec = (Array.isArray(data.patentFileWrapperDataBag) && data.patentFileWrapperDataBag[0]) || data;
  const md = (rec && rec.applicationMetaData) || rec || {};
  return {
    groupArtUnit: md.groupArtUnitNumber || '',
    examiner: md.examinerNameText || md.firstExaminerName || '',
    filingDate: md.filingDate || '',
    patentNumber: md.patentNumber || md.patentNumberText || '',
  };
}
