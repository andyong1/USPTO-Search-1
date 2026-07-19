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

// Prior-art reference NAMES (inventor surnames) cited in obviousness/anticipation
// grounds, e.g. "obvious over Asada in view of Kinoshita" -> {asada, kinoshita}.
// Many reexam decisions and IPR petitions identify their art by name, not number,
// so this is essential to match grounds like a §325(d) "same art" denial. Anchored
// on the standard grounds prepositions to stay precise; lower-cased for matching.
const NAME_STOP = new Set(['the', 'claim', 'claims', 'said', 'further', 'other', 'each', 'both',
  'these', 'those', 'independent', 'dependent', 'patent', 'patents', 'reference', 'references',
  'requester', 'petitioner', 'ground', 'grounds', 'view', 'combination', 'art', 'admitted', 'applicant',
  'prior', 'itself', 'record', 'office', 'examiner', 'board', 'and', 'any', 'all', 'this', 'that']);
const NAME = "[A-Z][A-Za-z'’.-]{2,}";
// A grounds clause begins at one of these anchors …
const NAME_ANCHOR = new RegExp(`(?:\\bover|anticipated by|\\bin (?:further )?view of|\\bin combination with)\\s*(${NAME})`, 'g');
// … and chains further references via these connectives (each followed by a name).
const NAME_CONNECTOR = new RegExp(
  `^(?:\\s*,\\s*(?:and )?|\\s+and (?:further )?(?:in (?:further )?view of )?|\\s+in (?:further )?view of |\\s+in combination with |\\s+further in view of )(${NAME})`);
export function extractReferenceNames(text) {
  const t = String(text || '').replace(/\s+/g, ' ');
  const names = new Set();
  const push = (w) => {
    const s = String(w || '').replace(/['’].*$/, '').replace(/[.\-]+$/, '').toLowerCase(); // drop possessive/trailing punct
    if (s.length >= 3 && !NAME_STOP.has(s)) { names.add(s); return true; }
    return false;
  };
  let m;
  while ((m = NAME_ANCHOR.exec(t))) {
    push(m[1]);
    // Walk the chain: consume "(connector)(Name)" repeatedly from where we are.
    let pos = m.index + m[0].length;
    for (;;) {
      const c = t.slice(pos).match(NAME_CONNECTOR);
      if (!c) break;
      if (NAME_STOP.has(c[1].toLowerCase())) break; // e.g. "and the Board", "and Requester"
      push(c[1]);
      pos += c[0].length;
    }
  }
  return [...names].sort();
}

// Everything comparable for one document: prior-art reference numbers AND names,
// de-duped. Names are lower-case words, numbers are digit strings — they never
// collide, so both sides intersect cleanly in compareGrounds().
export function extractAllRefs(text) {
  return [...new Set([...extractReferences(text), ...extractReferenceNames(text)])].sort();
}

// PTAB trial numbers mentioned in the text, canonicalized to "IPR2020-01234".
// Tolerates OCR separators: "IPR 2020 01234", "IPR2020-01234", "IPR2020 01234".
export function extractTrialNumbers(text) {
  const t = String(text || '');
  const out = new Set();
  // OCR-tolerant: the type may be split ("I PR"), and the separators between the
  // type, year, and serial are often mangled (space, en-dash, or the replacement
  // char) — so allow an internal space in the type and up to 3 non-alphanumerics
  // as each separator.
  const re = /\b(I\s?P\s?R|P\s?G\s?R|C\s?B\s?M)[^0-9A-Za-z]{0,3}(20[0-9]{2})[^0-9A-Za-z]{0,3}([0-9]{5})\b/gi;
  let m;
  while ((m = re.exec(t))) {
    out.add(`${m[1].replace(/\s/g, '').toUpperCase()}${m[2]}-${m[3]}`);
  }
  return [...out].sort();
}

// Classify how substantively a reexamination determination discusses 35 U.S.C.
// §325(d). Mere presence of the statute — and the standard "same or substantially
// the same art" recitation — is near-universal boilerplate, so this distinguishes:
//   'none'        — statute not cited
//   'recited'     — cited, but only the boilerplate (no related proceeding tie AND
//                   no side-by-side grounds comparison)
//   'substantive' — cites §325(d) AND names a related proceeding (a PTAB trial or a
//                   co-pending/prior reexam) AND lays out the "proposed grounds …
//                   material for the §325(d) analysis" side-by-side structure.
// Returns { level, relatedProceedings, structure }. Pure + unit-tested.
export function classify325d(text) {
  const t = String(text || '');
  if (!/325\s*\(\s*d\s*\)/i.test(t)) return { level: 'none', relatedProceedings: [], structure: false };
  const trials = extractTrialNumbers(t);
  const priorReexam = /\b(?:co-?pending|copending|concurrent|prior|earlier|related)\s+reexam/i.test(t);
  // Structural markers of an actual side-by-side grounds comparison (vs. reciting
  // the statute): the "proposed grounds … material" layout or an explicit framework.
  // Structural markers of an actual side-by-side grounds comparison (vs. reciting
  // the statute). "[\s\S]{0,40}?" (not "[^.]") so the periods in "U.S.C." don't
  // cut the match short; the label is often "grounds"/"challenges"/"rejections".
  const structure = /proposed grounds/i.test(t)
    || /material\s+(?:to|for)\s+the\b[\s\S]{0,40}?325\s*\(\s*d\s*\)/i.test(t)
    || /following\s+\w+(?:\s+\w+)?\s+(?:which|that)\s+are\s+material/i.test(t)
    || /advanced\s+bionics/i.test(t) || /becton/i.test(t);
  const hasRelated = trials.length > 0 || priorReexam;
  return { level: (hasRelated && structure) ? 'substantive' : 'recited', relatedProceedings: trials, structure };
}

// Canonicalize an externally-supplied trial number (e.g. from patent_proceedings)
// to the same "IPR2020-01234" form, for comparing against extractTrialNumbers().
export function canonTrial(s) {
  const m = String(s || '').match(/(IPR|PGR|CBM)[\s-]?(20[0-9]{2})[\s-]?([0-9]{5})/i);
  return m ? `${m[1].toUpperCase()}${m[2]}-${m[3]}` : null;
}

// True if a PTAB document's type/title identifies it as the operative petition
// (the source of the asserted grounds) — not a reply, response, opposition, or
// notice, which also contain "petition(er)". Used to pick the petition to parse.
export function isPetitionDoc(s) {
  return /\bpetition\b/i.test(String(s || '')) &&
    !/repl|response|opp|notice|mandatory|power of attorney|exhibit|list/i.test(String(s || ''));
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
