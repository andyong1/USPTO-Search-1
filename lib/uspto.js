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

// Classify who requested an ex parte reexamination from its document codes.
// Verified against live records: a third-party-requested reexam carries the
// "Receipt of Original Ex Parte Request by Third Party" document (RXOSUB.R) plus
// other third-party-only papers (IDS/affidavit filed by 3rd party, requestor
// petitions/replies, patent-owner pre-order submission). When none of those
// appear, the reexam has no third-party footprint and is inferred patent-owner-
// requested. Returns 'third_party' | 'patent_owner' | 'unknown' (no doc data).
const TP_EXACT = new Set(['RXOSUB.R', 'RXIDS.R', 'RXAF/DR', 'RXOPPPET', 'RX.PRO.PO']);
const TP_PREFIX = ['RXPET', 'RXRR', 'RXOR.']; // requestor petition / requestor reply / owner statement to order
export function classifyRequester(docs) {
  if (!Array.isArray(docs) || !docs.length) return 'unknown';
  for (const d of docs) {
    const code = String(d.documentCode || '').toUpperCase();
    if (!code) continue;
    if (TP_EXACT.has(code) || TP_PREFIX.some((p) => code.startsWith(p))) return 'third_party';
  }
  return 'patent_owner';
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
  // Prefer the document's real download URL from metadata; fall back to the
  // constructed {docId}.{ext} (correct for most docs, but 400s for ones whose
  // real URL is a nested .../files/{fileId}.{ext} path — e.g. some petitions).
  let url = `${DL_BASE}/${encodeURIComponent(appNum)}/${encodeURIComponent(documentId)}.${ext}`;
  try {
    const docs = await fetchDocuments(appNum, Math.min(timeoutMs, 10000));
    const doc = docs.find((d) => d.documentIdentifier === documentId);
    const want = String(format).toUpperCase();
    const opt = doc && (doc.downloads || []).find((o) => want === 'PDF' ? /pdf/i.test(o.mime) : String(o.mime).toUpperCase().includes(want));
    if (opt && opt.url) url = opt.url;
  } catch { /* fall back to the constructed URL */ }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url, { headers: { 'X-API-KEY': getApiKey() }, signal: controller.signal });
  } catch (e) {
    throw new Error(`USPTO document download failed for ${appNum}/${documentId}: ${e.name === 'AbortError' ? 'timed out' : e.message}`);
  } finally {
    clearTimeout(timer);
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
  };
}
