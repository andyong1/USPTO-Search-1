// Pure PTAB FWD outcome classification — no I/O or heavy deps, so it's unit-
// testable in isolation. lib/ptab.js re-exports these alongside its PDF/fetch code.

// Bump to force the classify pass to reprocess every row (getPtabFwdToClassify
// selects rows whose stored classified_v is below this).
export const CLASSIFIER_V = 7; // v7: caption disposition-aware ("All Claims Patentable" = po_none)

// Bump to force the Director-discretionary-decision (DD) check to re-run.
// v2: re-sweep after adding retry to the documents fetch — earlier bulk runs
// dropped DD flags (or set 'error') on transient 404/429s from the USPTO API.
export const DD_CHECK_V = 2;
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

// Outcome buckets (DA-5):
//   petitioner_all   — all challenged claims unpatentable (petitioner total win)
//   po_none          — no challenged claims unpatentable (patent owner total win)
//   partial          — some challenged claims unpatentable
//   adverse_judgment — judgment entered against the patent owner without a merits
//                      caption (substantively a patent-owner loss; kept separate
//                      so it can't silently distort claim-level win rates)
//   settled          — proceeding terminated on settlement (no merits outcome)
//   needs_review     — the classifier matched nothing ("classifier failed" is no
//                      longer conflated with "genuinely unusual" = other)
//   other            — legacy bucket (pre-v6 rows until reclassified)
export const FWD_OUTCOMES = ['petitioner_all', 'partial', 'po_none', 'adverse_judgment', 'settled', 'needs_review', 'other'];

// Classify an FWD from its (full) text. Prefer the Board's standardized caption
// "…Determining {All|No|Some} … Challenged Claims [Unpatentable]"; otherwise fall
// back to the quantifier disposition and negation-aware holding language that
// appear in the ORDER/conclusion.
export function classifyFwd(text) {
  const t = String(text || '').replace(/\s+/g, ' ');
  if (t.length < 20) return { outcome: 'needs_review', detail: 'no extractable text' };

  // 1) Standardized caption (title page or JUDGMENT of most FWDs). Allow the
  // singular "Challenged Claim", and make "Challenged" optional — some captions
  // read "Determining No Claims Unpatentable". Capture the disposition word:
  // most say "…Unpatentable", but a total PO win can read "…Claims Patentable"
  // (e.g. IPR2025-00349 "Determining All Challenged Claims Patentable"), which
  // INVERTS the All/No mapping — so read it rather than assume "unpatentable".
  const cap = t.match(/Determining\s+(All|No|Some)\s+(?:of\s+the\s+)?(?:Challenged\s+)?Claims?\b[^.]{0,20}?(Un)?[Pp]atentable\b/i);
  if (cap) {
    const w = cap[1].toLowerCase();
    if (w === 'some') return { outcome: 'partial', detail: 'caption: ' + cap[0].trim() };
    const unpat = !!cap[2]; // "Unpatentable" vs bare "Patentable"
    const petWin = unpat ? (w === 'all') : (w === 'no');
    return { outcome: petWin ? 'petitioner_all' : 'po_none', detail: 'caption: ' + cap[0].trim() };
  }

  // Negation-aware "some claims survived" signal (also used by the fallback below).
  const negate = /\bnot\s+held\s+unpatentable/i.test(t)
    || /\bhas\s+not\s+(?:shown|demonstrated|established|proven|proved)\b.{0,220}?\bunpatentab/i.test(t)
    || /\bfailed\s+to\s+(?:show|establish|demonstrate|prove)\b.{0,220}?\bunpatentab/i.test(t);

  // 1b) Caption naming unpatentable claims WITHOUT an All/No/Some quantifier:
  //   "Determining Challenged Claim Unpatentable"                → petitioner win (the challenged claim(s) are unpatentable)
  //   "Determining Challenged Claims 1, 3–11, … Unpatentable"    → specific claims listed: partial if the body shows
  //     survivors ("has not shown … unpatentable"), else all challenged claims were in the list → petitioner win.
  const cap2 = t.match(/Determining\s+(?:the\s+)?Challenged\s+Claims?\b([^.]{0,80}?)\bUnpatentable/i);
  if (cap2 && !/\bnot\b/i.test(cap2[1])) {
    if (/\d/.test(cap2[1]) && negate) return { outcome: 'partial', detail: 'caption: listed claims unpatentable + survivors' };
    return { outcome: 'petitioner_all', detail: 'caption: ' + cap2[0].trim().slice(0, 60) };
  }

  // 1c) Non-merits dispositions that flow through the FWD feed (DA-5). An
  // adverse judgment (37 C.F.R. 42.73(b)) is entered against the patent owner —
  // substantively a PO loss — and a settlement termination has no merits outcome.
  // Neither uses the standardized caption, so before v6 they polluted 'other'.
  if (/\badverse\s+judgment\b/i.test(t)) return { outcome: 'adverse_judgment', detail: 'adverse judgment' };
  if (/\b(?:joint\s+motion\s+to\s+terminate|terminat\w*\b.{0,120}?\bsettlement|settlement\b.{0,120}?\bterminat)/i.test(t)) {
    return { outcome: 'settled', detail: 'settlement termination' };
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

  if (someU) return { outcome: 'partial', detail: 'some challenged claims unpatentable' };
  if (noU && !allU) return { outcome: 'po_none', detail: 'no challenged claims unpatentable' };
  if (affirm && negate) return { outcome: 'partial', detail: 'order: mixed holding' };
  if (allU && !negate) return { outcome: 'petitioner_all', detail: 'all challenged claims unpatentable' };
  if (affirm) return { outcome: 'petitioner_all', detail: 'order: held unpatentable' };
  if (negate) return { outcome: 'po_none', detail: 'order: not shown unpatentable' };
  if (allU && noU) return { outcome: 'partial', detail: 'mixed quantifiers' };
  return { outcome: 'needs_review', detail: 'no disposition matched' };
}
