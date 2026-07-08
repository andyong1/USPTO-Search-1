// Pure PTAB FWD outcome classification — no I/O or heavy deps, so it's unit-
// testable in isolation. lib/ptab.js re-exports these alongside its PDF/fetch code.

// Bump to force the classify pass to reprocess every row (getPtabFwdToClassify
// selects rows whose stored classified_v is below this).
export const CLASSIFIER_V = 1;

// Outcome buckets:
//   petitioner_all — all challenged claims unpatentable (petitioner total win)
//   po_none        — no challenged claims unpatentable (patent owner total win)
//   partial        — some challenged claims unpatentable
//   other          — non-standard disposition (adverse judgment, unusual) → review
export const FWD_OUTCOMES = ['petitioner_all', 'partial', 'po_none', 'other'];

// Classify an FWD from its (full) text. Prefer the Board's standardized caption
// "…Determining {All|No|Some} … Challenged Claims [Unpatentable]"; otherwise fall
// back to negation-aware holding language in the ORDER/conclusion.
export function classifyFwd(text) {
  const t = String(text || '').replace(/\s+/g, ' ');
  if (t.length < 20) return { outcome: 'other', detail: '' };

  // 1) Standardized caption (title page or JUDGMENT of most FWDs).
  const cap = t.match(/Determining\s+(All|No|Some)\s+(?:of\s+the\s+)?Challenged\s+Claims/i);
  if (cap) {
    const w = cap[1].toLowerCase();
    return { outcome: w === 'all' ? 'petitioner_all' : w === 'no' ? 'po_none' : 'partial', detail: 'caption: ' + cap[0].trim() };
  }

  // 2) ORDER/conclusion holding language. Negation-aware: "has not shown …
  // unpatentable" must NOT read as an affirmative unpatentability holding, and
  // "held unpatentable" only counts affirmatively when not preceded by "not".
  const affirm = /(?<!not\s)\bheld\s+unpatentable/i.test(t)
    || /\b(petitioner\s+)?has\s+shown[^.]{0,200}\bunpatentable/i.test(t)
    || /\bhave\s+been\s+shown\s+to\s+be\s+unpatentable/i.test(t);
  const negate = /\bnot\s+held\s+unpatentable/i.test(t)
    || /\bhas\s+not\s+shown[^.]{0,220}\bunpatentable/i.test(t)
    || /\bfailed\s+to\s+(show|establish|demonstrate|prove)[^.]{0,220}\bunpatentable/i.test(t);
  if (affirm && negate) return { outcome: 'partial', detail: 'order: mixed holding' };
  if (affirm) return { outcome: 'petitioner_all', detail: 'order: held unpatentable' };
  if (negate) return { outcome: 'po_none', detail: 'order: not shown unpatentable' };
  return { outcome: 'other', detail: '' };
}
