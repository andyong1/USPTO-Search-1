// Phase-2 dispositive-document identification for the ITC outcome classifier.
//
// EDIS's documentType is a clean, reliable signal (far better than titles):
//   'Opinion, Commission'                  → the Commission Opinion (authority)
//   'ID/RD - Final on Violation'           → the final merits Initial Determination
//   'Order, Commission'                    → consent / exclusion / cease-and-desist orders
//   'ID/RD - Other Than Final on Violation'→ partial/procedural IDs (incl. terminations)
//   'Notice' (title-dependent)             → Commission action notices (review / terminate)
// We map these to roles and select the SMALL terminal subset the AI must read,
// so text volume (and Neon storage) stays bounded.

// Version of the AI classification prompt/logic. Bump to force re-classification
// of every investigation (itc-outcome-fetch.mjs re-stages those behind it).
export const OUTCOME_AI_V = 1;

export function dispositiveRole(type, title) {
  const t = String(type || '').toLowerCase().trim();
  const ti = String(title || '').toLowerCase();
  if (t === 'opinion, commission') return 'opinion';
  if (t === 'id/rd - final on violation') return 'final_id';
  if (t === 'order, commission') {
    if (/consent order/.test(ti)) return 'consent_order';
    if (/exclusion order|cease and desist/.test(ti)) return 'remedy_order';
    return 'commission_order';
  }
  if (t === 'id/rd - other than final on violation') return 'partial_id';
  if (t === 'notice') {
    // Commission action notices — the manual confirms Commission final
    // determinations/decisions are filed as "Notice" (incl. F.R. notices), and
    // there is NO dedicated exclusion-order type: remedies are ANNOUNCED here
    // ("issuance of a limited exclusion order and cease and desist orders").
    if (/determination|to review|not to review|terminat|violation|remed|exclusion order|cease and desist|consent order|issuance of/.test(ti)) return 'commission_notice';
  }
  // ── Pre-EDIS (older investigations) type labels ──────────────────────
  // Old records use different document_type strings; without these the
  // dispositive docs (and thus the outcome) go unrecognized.
  if (t === 'opinion' || t === 'court opinion') return 'opinion';
  if (t.includes('pre-edis')) return 'final_id';        // "ID/RD - Pre-EDIS -II" — the ALJ determination
  if (t === 'order') {                                    // bare "Order" is mostly procedural — dispositive only by title
    if (/exclusion order|cease and desist|consent order|final determination|terminat/.test(ti)) return 'commission_order';
  }
  return null; // procedural / party filings / returned mail — not dispositive
}

// Documents worth mirroring for on-site download: the dispositive set (Commission
// opinion, final ID, remedy/consent orders) plus the latest final-determination
// notice, the complaint, and the notice of investigation. Type-driven (tight — no
// procedural-ID flood), public-only, deduped. Returns {id, role, title, date}.
export function selectMirrorDocs(docs) {
  const pub = docs.filter((d) => (d.security_level || '').toLowerCase() === 'public');
  const picks = new Map();
  const add = (d, role) => { if (d && d.id && !picks.has(d.id)) picks.set(d.id, { id: d.id, role, title: d.document_title, date: d.received_date }); };

  for (const d of pub) {
    const r = dispositiveRole(d.document_type, d.document_title);
    if (r === 'opinion' || r === 'final_id' || r === 'remedy_order' || r === 'consent_order' || r === 'commission_order') add(d, r);
  }
  // Latest Commission notice (the Federal Register final-determination notice).
  const notices = pub.filter((d) => dispositiveRole(d.document_type, d.document_title) === 'commission_notice')
    .sort((a, b) => String(b.received_date || '').localeCompare(String(a.received_date || '')));
  if (notices[0]) add(notices[0], 'commission_notice');

  // ONE complaint (the operative pleading) and ONE notice of investigation.
  // Title regexes must be tight: "notice of investigation" and "complaint" appear
  // in dozens of procedural filings (responses, motions, supplements, amendment
  // IDs), which would otherwise mirror ~6× too many docs.
  const isComplaint = (d) => {
    const ti = String(d.document_title || '').toLowerCase();
    return String(d.document_type || '').toLowerCase() === 'complaint'
      && /\bcomplaint\b/.test(ti)
      && !/supplement|response|motion|granting|opposition|extension|answer|errata|withdraw|amend to|letter/.test(ti);
  };
  const complaints = pub.filter(isComplaint) // latest first → the operative (amended) complaint
    .sort((a, b) => String(b.received_date || '').localeCompare(String(a.received_date || '')));
  if (complaints[0]) add(complaints[0], 'complaint');

  const isNOI = (d) => {
    const ti = String(d.document_title || '').toLowerCase();
    return /^(notice of investigation|institution of investigation|notice of institution)/.test(ti)
      && !/motion|response|granting|amend|determination|extension|order/.test(ti);
  };
  const nois = pub.filter(isNOI) // earliest → the institution NOI
    .sort((a, b) => String(a.received_date || '').localeCompare(String(b.received_date || '')));
  if (nois[0]) add(nois[0], 'notice_of_investigation');

  return [...picks.values()];
}

// Given an investigation's documents (each {id, document_type, document_title,
// received_date}), return the terminal subset to extract for classification —
// each tagged with role, newest-first within role, capped at 8 documents.
export function selectDispositive(docs) {
  const roled = docs
    .map((d) => ({ id: d.id, role: dispositiveRole(d.document_type, d.document_title), type: d.document_type, title: d.document_title, date: d.received_date }))
    .filter((d) => d.id && d.role);
  const byRole = (r) => roled.filter((d) => d.role === r).sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));

  const opinions = byRole('opinion');
  const finalIds = byRole('final_id');
  const orders = [...byRole('remedy_order'), ...byRole('consent_order'), ...byRole('commission_order')];
  const notices = byRole('commission_notice');
  const partialIds = byRole('partial_id');

  const picks = [];
  picks.push(...opinions.slice(0, 2));       // the Commission's reasoning (latest)
  picks.push(...finalIds.slice(0, 1));       // the merits ID
  picks.push(...orders.slice(0, 4));         // remedy / consent orders
  picks.push(...notices.slice(0, 2));        // final Commission action notices
  // Termination path (settled/consent/default — no opinion or merits ID): the ID
  // granting termination plus its notice carry the disposition.
  if (!opinions.length && !finalIds.length) picks.push(...partialIds.slice(0, 2));

  const seen = new Set();
  return picks.filter((d) => !seen.has(d.id) && seen.add(d.id)).slice(0, 8);
}
