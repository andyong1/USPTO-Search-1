// Extract the prior-art references and PTAB-trial mentions from the text of a
// reexamination order/denial or a PTAB decision, so we can compare whether a
// reexamination raises the same art/grounds as a prior/parallel PTAB proceeding.
//
// This is deliberately heuristic and precision-biased: on scanned reexam orders
// (OCR'd), we accept some missed references rather than grab claim ranges, dates,
// or statute cites as false art. A reference that IS matched on both sides is a
// high-confidence overlap; a non-match means "not detected", never "no overlap".
// All functions are pure and unit-tested (test/units.test.js).

// Canonicalize a run of digits pulled from a citation: strip everything but
// digits (OCR sprinkles spaces/periods inside numbers, e.g. "5,575,86 1").
function digits(s) {
  return String(s || '').replace(/[^0-9]/g, '');
}

// Prior-art references cited in the text, as canonical digit strings so the two
// sides intersect by string equality:
//   utility patents      -> 7-8 digit string           (US 5,575,861 -> "5575861")
//   pre-grant pubs        -> 11 digit string (YYYY+serial) (US 2008/0216889 -> "20080216889")
// Both forms require the "US" prefix to stay precise (avoids "35 U.S.C. 103",
// claim ranges, dates). Kind codes (B1/B2/A1) and OCR spaces are tolerated.
export function extractReferences(text) {
  const t = String(text || '');
  const refs = new Set();

  // Pre-grant publication: US YYYY/nnnnnnn (serial may have OCR spaces).
  const pubRe = /\bUS\s?([12][0-9]{3})\s?\/\s?([0-9][0-9 ]{5,8}[0-9])/gi;
  let m;
  while ((m = pubRe.exec(t))) {
    const canon = m[1] + digits(m[2]);
    if (canon.length >= 10 && canon.length <= 12) refs.add(canon);
  }

  // Utility patent: US n,nnn,nnn (comma-grouped, OCR spaces tolerated). Also
  // 8-digit (n,nnn,nnn / nn,nnn,nnn). Requires the comma grouping to avoid
  // matching arbitrary long numbers.
  const patRe = /\bUS\s?([0-9][0-9 ]{0,2},\s?[0-9][0-9 ]{2,3},\s?[0-9][0-9 ]{2,3})(?:\s?[ABC][0-9])?/gi;
  while ((m = patRe.exec(t))) {
    const canon = digits(m[1]);
    if (canon.length === 7 || canon.length === 8) refs.add(canon);
  }

  return [...refs].sort();
}

// PTAB trial numbers mentioned in the text, canonicalized to "IPR2020-01234".
// Tolerates OCR separators: "IPR 2020 01234", "IPR2020-01234", "IPR2020 01234".
export function extractTrialNumbers(text) {
  const t = String(text || '');
  const out = new Set();
  const re = /\b(IPR|PGR|CBM)[\s-]?(20[0-9]{2})[\s-]?([0-9]{5})\b/gi;
  let m;
  while ((m = re.exec(t))) {
    out.add(`${m[1].toUpperCase()}${m[2]}-${m[3]}`);
  }
  return [...out].sort();
}

// Canonicalize an externally-supplied trial number (e.g. from patent_proceedings)
// to the same "IPR2020-01234" form, for comparing against extractTrialNumbers().
export function canonTrial(s) {
  const m = String(s || '').match(/(IPR|PGR|CBM)[\s-]?(20[0-9]{2})[\s-]?([0-9]{5})/i);
  return m ? `${m[1].toUpperCase()}${m[2]}-${m[3]}` : null;
}

// Compare a reexam order's extracted signals against one prior PTAB proceeding.
// Returns { mentioned, sharedRefs } — whether the order names that trial, and the
// prior-art references cited by BOTH the order and the PTAB decision.
//   orderRefs / ptabRefs   arrays from extractReferences()
//   orderTrials            array from extractTrialNumbers() (order text)
//   trialNumber            the proceeding's number (canonicalized here)
export function compareGrounds({ orderRefs = [], orderTrials = [], ptabRefs = [], trialNumber = '' } = {}) {
  const canon = canonTrial(trialNumber);
  const mentioned = !!canon && orderTrials.includes(canon);
  const ptabSet = new Set(ptabRefs);
  const sharedRefs = orderRefs.filter((r) => ptabSet.has(r));
  return { mentioned, sharedRefs };
}
