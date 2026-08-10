// Detection of post-order patent owner petitions and the surrounding cluster:
//   - Patent Owner Petition: document code PET.OP filed after the reexam was
//     ordered (if multiple PET.OP, the fewest-page one is the petition itself,
//     the rest being exhibits).
//   - Requester Opposition: RXPET. ("Receipt of Petition in a Reexam") filed by
//     the third-party requester after the petition.
//   - Petition Decision: an Office of Petitions decision (RXPTGR granted /
//     RXPTDI dismissed, or a petition decision document) after the petition.

import { fetchDocuments, fetchDocumentBytes } from './uspto.js';
import { recordPostPetition, markPetitionScan } from './db.js';
import { extractPdfText, detect325d } from './reexamOutcome.js';
import { ocrTextConfigured, ocrTextOfBuffer } from './ocr.js';

// Determine whether a patent owner petition cites 35 U.S.C. 325(d). Text-first
// (most petitions are e-filed text PDFs); falls back to OCR for image-only ones.
// With allowOcr=false (the hourly cron), an image-only petition returns
// { is325d: null, method: 'pending-ocr' } so the slow OCR is left to the backfill.
// Returns { is325d, method }. Throws on a transient download failure so the
// caller can retry.
export async function detectPetition325d(appNum, docId, { allowOcr = true, downloadMs = 20000, ocrChunks = 2 } = {}) {
  const { buffer } = await fetchDocumentBytes(appNum, docId, 'PDF', downloadMs);
  let text = '';
  try { text = await extractPdfText(buffer); } catch { text = ''; }
  if (text && text.replace(/\s/g, '').length >= 100) {
    return { is325d: detect325d(text), method: 'text' };
  }
  if (!allowOcr) return { is325d: null, method: 'pending-ocr' };
  if (!ocrTextConfigured()) return { is325d: false, method: 'none' };
  text = await ocrTextOfBuffer(buffer, ocrChunks);
  return { is325d: detect325d(text), method: 'ocr' };
}

// The patent owner's petition is coded PET.OP or RXPET.; the requester's
// opposition is RXOPPPET (or a later PET.OP/RXPET. paper). Role is decided by
// timing — the earliest petition-type paper after the order is the petition.
const PETITION_CODES = new Set(['PET.OP', 'RXPET.']);
const OPP_CODE = 'RXOPPPET';
const DECISION = { RXPTGR: 'granted', RXPTDI: 'dismissed' };
const parseISO = (s) => { const m = String(s || '').match(/(\d{4})-?(\d{2})-?(\d{2})/); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : NaN; };
const pages = (d) => (d.pageCount == null ? Infinity : d.pageCount);

// ── Petition-trail collection (ALL petitions/oppositions/decisions, any party) ──
// Classify one file-wrapper document as a petition-trail event, or null if it
// isn't petition-related. Code-first (RXPT* decision codes carry the outcome —
// RXPTGR granted / RXPTDI dismissed); description fallback for odd decision
// codes. SE.PET covers supplemental-examination petitions (96/ series).
export function classifyPetitionDoc(code, desc) {
  const c = String(code || '').toUpperCase();
  const t = String(desc || '').toLowerCase();
  if (c === 'PET.OP' || c === 'RXPET.' || c === 'SE.PET') return { kind: 'petition' };
  // RXRPET = "Petition for Review of Reexam Denial" — a distinct petition type
  // (challenging the threshold order/denial itself, not a mid-prosecution
  // procedural ask) filed by the requester, sometimes months after a denial.
  if (c === 'RXRPET') return { kind: 'petition' };
  // RXRQ/T = "Reexam Request for Extension of Time" — a specific petition code
  // USPTO sometimes assigns on reclassification, after the document was
  // initially docketed under a generic petition code (found via a gap between
  // the post-order patent-owner-petition table and this broader table: the
  // narrower table's cached doc_id pointed at what is now an RXRQ/T-coded doc).
  if (c === 'RXRQ/T') return { kind: 'petition' };
  // The Office's ruling on an RXRQ/T extension request. These don't start with
  // RXPT, so without them every extension petition would read as permanently
  // pending. Surfaced by the unrecognized-code audit right after RXRQ/T was
  // added -- the request and its decision have to be added as a pair.
  if (c === 'RXEXTG') return { kind: 'decision', outcome: 'granted' };
  if (c === 'RXEXTD') return { kind: 'decision', outcome: 'denied' };
  if (c === 'RXOPPPET') return { kind: 'opposition' };
  if (/^RXPT/.test(c)) {
    // RXPTGP is "Granted - in-part" — a partial grant, kept distinct from a full
    // grant so petition statistics aren't overstated. Check it before RXPTGR.
    const outcome = c === 'RXPTGP' ? 'granted_in_part'
      : c === 'RXPTGR' ? 'granted' : c === 'RXPTDI' ? 'dismissed' : c === 'RXPTDE' ? 'denied'
      : /in.?part/.test(t) ? 'granted_in_part'
      : /grant/.test(t) ? 'granted' : /dismiss/.test(t) ? 'dismissed' : /denied|deny/.test(t) ? 'denied' : 'decided';
    return { kind: 'decision', outcome };
  }
  // Fallback: a decision-on-petition document under some other code.
  if (/petition/.test(t) && /decision|dismiss|grant|denied/.test(t) && !/receipt|opposition/.test(t)) {
    const outcome = /dismiss/.test(t) ? 'dismissed' : /grant/.test(t) ? 'granted' : /denied/.test(t) ? 'denied' : 'decided';
    return { kind: 'decision', outcome };
  }
  return null;
}

// Thread one proceeding's petition-trail docs (rows: {doc_id, official_date,
// doc_code, kind, outcome}) into petition→opposition→decision rows, at read
// time. FIFO pairing: a decision closes the earliest still-open petition; an
// opposition attaches to the most recent open one. Orphans (a decision or
// opposition whose petition paper isn't in IFW) become their own row. Pure and
// deterministic — unit-tested.
// Extension-of-time practice is its own self-contained family: an RXRQ/T request
// is answered by RXEXTG/RXEXTD and by nothing else. Threading must respect that,
// because FIFO pairing across the whole proceeding would let an extension GRANT
// close an earlier, unrelated substantive petition -- e.g. 90015644, where a
// § 325(d) petition and its opposition are followed by an unrelated RXEXTG, would
// have rendered that § 325(d) petition as "granted". Same misattribution class as
// crediting a leave-to-file grant to the relief sought.
const EXT_FAMILY = new Set(['RXRQ/T', 'RXEXTG', 'RXEXTD']);
const family = (r) => (EXT_FAMILY.has(String(r.doc_code || '').toUpperCase()) ? 'extension' : 'general');

export function threadPetitions(rows) {
  // Thread each family independently, then merge — a decision can only ever close
  // a petition of its own family.
  const fams = new Map();
  for (const r of rows) {
    const f = family(r);
    if (!fams.has(f)) fams.set(f, []);
    fams.get(f).push(r);
  }
  if (fams.size > 1) return [...fams.values()].flatMap((rs) => threadOneFamily(rs));
  return threadOneFamily(rows);
}

function threadOneFamily(rows) {
  const key = (r) => `${r.official_date || '9999-99-99'}|${{ petition: 0, opposition: 1, decision: 2 }[r.kind] ?? 3}|${r.doc_id}`;
  const sorted = [...rows].sort((a, b) => key(a) < key(b) ? -1 : 1);
  const threads = [], open = [];
  for (const r of sorted) {
    if (r.kind === 'petition') {
      const t = { petition: r, opposition: null, decision: null };
      threads.push(t); open.push(t);
    } else if (r.kind === 'opposition') {
      const t = [...open].reverse().find((x) => !x.opposition);
      if (t) t.opposition = r;
      else threads.push({ petition: null, opposition: r, decision: null });
    } else if (r.kind === 'decision') {
      const i = open.findIndex((x) => !x.decision);
      if (i >= 0) { open[i].decision = r; open.splice(i, 1); }
      else threads.push({ petition: null, opposition: null, decision: r });
    }
  }
  return threads;
}

// Find a proceeding's post-order petition cluster and record it. Always marks the
// app scanned. Returns 1 if a patent owner petition was found, else 0.
export async function detectPostOrderPetitionForApp(appNum, orderDate) {
  const docs = await fetchDocuments(appNum);
  const orderMs = parseISO(orderDate);

  // Patent owner petition: the earliest PET.OP/RXPET. on/after the order (fewest
  // pages breaks a same-date tie — the petition vs. its exhibits).
  let petition = null, petitionTied = false; // DA-11: same-date candidate collision
  for (const d of docs) {
    if (!PETITION_CODES.has((d.documentCode || '').toUpperCase())) continue;
    const t = parseISO(d.officialDate);
    if (!isNaN(orderMs) && !isNaN(t) && t < orderMs) continue;
    if (!petition) { petition = d; continue; }
    const pt = parseISO(petition.officialDate);
    if (!isNaN(t) && t === pt) petitionTied = true; // role assigned by page-count tie-break — review
    if ((!isNaN(t) && !isNaN(pt) && t < pt) || (t === pt && pages(d) < pages(petition))) petition = d;
  }
  if (!petition) { await markPetitionScan(appNum); return 0; }
  const petMs = parseISO(petition.officialDate);
  const after = (d) => { const t = parseISO(d.officialDate); return !isNaN(t) && (isNaN(petMs) || t > petMs); };

  // Requester opposition (filed strictly after the petition): an explicit
  // RXOPPPET, otherwise the next PET.OP/RXPET. paper after the petition.
  let opposition = null;
  for (const d of docs) {
    if ((d.documentCode || '').toUpperCase() !== OPP_CODE || !after(d)) continue;
    if (!opposition || parseISO(d.officialDate) < parseISO(opposition.officialDate)) opposition = d;
  }
  if (!opposition) {
    for (const d of docs) {
      if (d === petition || !PETITION_CODES.has((d.documentCode || '').toUpperCase()) || !after(d)) continue;
      if (!opposition || parseISO(d.officialDate) < parseISO(opposition.officialDate)) opposition = d;
    }
  }

  // Petition decision: earliest grant/dismissal (by code or description) after it.
  let decision = null, outcome = null;
  for (const d of docs) {
    const code = (d.documentCode || '').toUpperCase();
    const desc = (d.description || '').toLowerCase();
    let oc = DECISION[code] || null;
    if (!oc && /petition/.test(desc) && /(dismiss|grant|denied|decision)/.test(desc)) {
      oc = /dismiss/.test(desc) ? 'dismissed' : /grant/.test(desc) ? 'granted' : /denied/.test(desc) ? 'denied' : 'decided';
    }
    if (!oc) continue;
    const t = parseISO(d.officialDate);
    if (!isNaN(petMs) && !isNaN(t) && t < petMs) continue;
    if (!decision || parseISO(d.officialDate) < parseISO(decision.officialDate)) { decision = d; outcome = oc; }
  }

  await recordPostPetition(appNum, {
    orderDate,
    petitionDocId: petition.documentIdentifier, petitionDate: petition.officialDate, petitionPages: petition.pageCount,
    oppositionDocId: opposition && opposition.documentIdentifier, oppositionDate: opposition && opposition.officialDate,
    decisionDocId: decision && decision.documentIdentifier, decisionDate: decision && decision.officialDate, decisionOutcome: outcome,
    reviewFlag: petitionTied,
  });
  await markPetitionScan(appNum);
  return 1;
}
