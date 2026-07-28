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
  return null; // procedural / party filings / returned mail — not dispositive
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
