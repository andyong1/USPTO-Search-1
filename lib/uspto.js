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
  // Petition decision codes: RXPTGR = granted, RXPTDI = dismissed.
  const DECISION = { RXPTGR: 'granted', RXPTDI: 'dismissed' };
  let decision = null;
  if (petition) {
    for (const d of docs) {
      if (!DECISION[(d.documentCode || '').toUpperCase()]) continue;
      if (!decision || parseISO(d.officialDate) < parseISO(decision.officialDate)) decision = d;
    }
  }
  const outcome = decision ? DECISION[(decision.documentCode || '').toUpperCase()] : null;
  return {
    petition: petition ? { id: petition.documentIdentifier, date: petition.officialDate } : null,
    decision: decision ? { id: decision.documentIdentifier, date: decision.officialDate, outcome } : null,
  };
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
      formats: (d.downloadOptionBag || d.downloadOptions || [])
        .map((o) => o.mimeTypeIdentifier || o.mimeType || '')
        .filter(Boolean),
    }))
    .filter((d) => d.documentIdentifier);
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
  };
}
