// Pure PTAB FWD outcome classification — no I/O or heavy deps, so it's unit-
// testable in isolation. lib/ptab.js re-exports these alongside its PDF/fetch code.

// Bump to force the classify pass to reprocess every row (getPtabFwdToClassify
// selects rows whose stored classified_v is below this).
export const CLASSIFIER_V = 3;

// Bump to force the Director-discretionary-decision (DD) check to re-run.
export const DD_CHECK_V = 1;
// The interim bifurcated discretionary-denial process began in early 2025, so
// only proceedings instituted on/after this can carry a "Director Discretionary
// Decision" — older FWDs are marked 'none' without a document fetch.
export const DD_CUTOFF = '2025-01-01';

// Given a proceeding's document list, detect a "Director Discretionary Decision:
// <subtype>" entry (e.g. "Refer" = referred to the Board, i.e. survived DD) and
// return the lowercased subtype, or 'none' if the proceeding never had one.
export function detectDdDecision(docs) {
  if (!Array.isArray(docs)) return 'none';
  for (const d of docs) {
    const s = String((d && (d.typeDesc || d.title)) || '');
    const m = s.match(/Director\s+Discretionary\s+Decision\s*:?\s*([A-Za-z][A-Za-z-]*)/i);
    if (m) return m[1].toLowerCase();
  }
  return 'none';
}

// Outcome buckets:
//   petitioner_all — all challenged claims unpatentable (petitioner total win)
//   po_none        — no challenged claims unpatentable (patent owner total win)
//   partial        — some challenged claims unpatentable
//   other          — non-standard disposition (adverse judgment, unusual) → review
export const FWD_OUTCOMES = ['petitioner_all', 'partial', 'po_none', 'other'];

// Classify an FWD from its (full) text. Prefer the Board's standardized caption
// "…Determining {All|No|Some} … Challenged Claims [Unpatentable]"; otherwise fall
// back to the quantifier disposition and negation-aware holding language that
// appear in the ORDER/conclusion.
export function classifyFwd(text) {
  const t = String(text || '').replace(/\s+/g, ' ');
  if (t.length < 20) return { outcome: 'other', detail: '' };

  // 1) Standardized caption (title page or JUDGMENT of most FWDs). Allow the
  // singular "Challenged Claim" — a handful of decisions use it.
  const cap = t.match(/Determining\s+(All|No|Some)\s+(?:of\s+the\s+)?Challenged\s+Claims?\b/i);
  if (cap) {
    const w = cap[1].toLowerCase();
    return { outcome: w === 'all' ? 'petitioner_all' : w === 'no' ? 'po_none' : 'partial', detail: 'caption: ' + cap[0].trim() };
  }

  // 2) Quantifier disposition — "{No|None|All|Each|Every|Some} challenged claim(s)
  // … [are/is/held] unpatentable" — stated in the ORDER/body rather than the
  // caption. "No/none … unpatentable" is an unambiguous PO win; "each/every" ≡
  // "all". Non-greedy any-char window (not [^.]) so citation/abbreviation periods
  // like "i.e., claims 1–8 of the '889 patent" don't cut the match short.
  const quant = (w) => new RegExp(`\\b${w}\\s+(?:of\\s+the\\s+)?challenged\\s+claims?\\b.{0,90}?\\bunpatentab`, 'i').test(t);
  const someU = quant('some');
  const noU = quant('no') || quant('none');
  const allU = quant('all') || quant('each') || quant('every');

  // 3) Negation-aware holding language. "has not shown/demonstrated … unpatentable"
  // must NOT read as an affirmative holding; "held unpatentable" only counts
  // affirmatively when not preceded by "not". Verbs: shown/demonstrated/
  // established/proven/proved.
  const affirm = /(?<!not\s)\bheld\s+unpatentable/i.test(t)
    || /\b(?:petitioner\s+)?has\s+(?:shown|demonstrated|established|proven|proved)\b.{0,220}?\bunpatentab/i.test(t)
    || /\bhave\s+been\s+(?:shown|demonstrated|proven|proved)\s+to\s+be\s+unpatentab/i.test(t);
  const negate = /\bnot\s+held\s+unpatentable/i.test(t)
    || /\bhas\s+not\s+(?:shown|demonstrated|established|proven|proved)\b.{0,220}?\bunpatentab/i.test(t)
    || /\bfailed\s+to\s+(?:show|establish|demonstrate|prove)\b.{0,220}?\bunpatentab/i.test(t);

  if (someU) return { outcome: 'partial', detail: 'some challenged claims unpatentable' };
  if (noU && !allU) return { outcome: 'po_none', detail: 'no challenged claims unpatentable' };
  if (affirm && negate) return { outcome: 'partial', detail: 'order: mixed holding' };
  if (allU && !negate) return { outcome: 'petitioner_all', detail: 'all challenged claims unpatentable' };
  if (affirm) return { outcome: 'petitioner_all', detail: 'order: held unpatentable' };
  if (negate) return { outcome: 'po_none', detail: 'order: not shown unpatentable' };
  if (allU && noU) return { outcome: 'partial', detail: 'mixed quantifiers' };
  return { outcome: 'other', detail: '' };
}
