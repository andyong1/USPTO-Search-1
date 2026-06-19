// Best-effort extraction of the claim disposition from an ex parte reexamination
// certificate (RXCERT) or Notice of Intent to Issue a Reexam Certificate (RXNIRC).
// The USPTO API has no structured field for this, so we read the PDF text and
// pattern-match the standard certificate language, e.g.:
//   "Claims 1-5 are confirmed."
//   "Claims 6 and 7 are cancelled."
//   "Claims 8-10 are determined to be patentable as amended."
//   "New claims 11-15 are added and determined to be patentable."
// A Notice of Intent (NIRC) instead uses the PTOL-465 form layout, where the
// list follows the label, e.g. "patent claim(s) confirmed: 1-20" (blank = none).
// Phrasing varies, so this is heuristic and may miss unusual wordings.

// Dynamically import the lib entry inside a try/catch so any load/bundle failure
// of pdf-parse degrades to "no text" instead of crashing the caller (the cron).
// Importing the lib file directly avoids pdf-parse's debug harness, which tries to
// read a sample file when the package root is imported.
export async function extractPdfText(buffer) {
  try {
    const mod = await import('pdf-parse/lib/pdf-parse.js');
    const pdf = mod.default || mod;
    const data = await pdf(buffer);
    return (data && data.text) ? data.text : '';
  } catch {
    return '';
  }
}

// True if the text invokes 35 U.S.C. 325(d) (used to flag petition decisions that
// include a 325(d) analysis). Best-effort: only works on machine-readable text.
export function detect325d(text) {
  if (!text) return false;
  return /\b325\s*\(\s*d\s*\)/i.test(text) || /\bsection\s+325\b/i.test(text);
}

// A claim list is digits/commas/periods/dashes/spaces, optionally joined by "and".
// Periods are allowed because OCR frequently misreads the commas between claim
// numbers as periods (e.g. "1-9. 11-13, 20. 21. 28"); tidy() normalizes them back.
const CLAIMS = '([0-9][0-9,.\\s\\-]*(?:and\\s+[0-9][0-9,.\\s\\-]*)*)';
const tidy = (s) => s
  .replace(/\s+/g, ' ')
  .replace(/(\d)\s*\.\s*(\d)/g, '$1, $2')   // OCR period between claim numbers -> comma
  .replace(/(\d)\s*-\s*(\d)/g, '$1-$2')     // normalize range spacing ("1 - 6" -> "1-6")
  .replace(/\s*,\s*/g, ', ')
  .replace(/\s+and\s+/g, ' and ')
  .trim()
  .replace(/[.,\s]+$/, '');

function grab(text, verb) {
  const re = new RegExp(`claims?\\s+${CLAIMS}\\s+(?:is|are)\\s+${verb}`, 'i');
  const m = text.match(re);
  return m ? tidy(m[1]) : '';
}

// Parse certificate/NIRC text into { confirmed, cancelled, amended, added, summary }.
// Returns null if nothing recognizable was found.
export function parseReexamOutcome(text) {
  if (!text) return null;
  // Normalize common OCR confusions in the disposition before matching:
  //   "claim I"/"claim l" -> "claim 1" (digit 1 read as a letter)
  //   "arc cancelled" -> "are cancelled" (are misread as arc)
  //   "1°"/footnote degree markers injected into a claim list -> removed
  const t = String(text)
    .replace(/\s+/g, ' ')
    .replace(/\b(claims?)\s+[Il]\b/g, '$1 1')
    .replace(/\barc\s+(cancell?ed|confirmed|determined|added|patentable)/gi, 'are $1')
    .replace(/\b\d+\s*°\s*(?=\d)/g, '')
    .replace(/°/g, '');

  // ── Prose format (final certificate): the list PRECEDES the verb, e.g.
  //    "Claims 1-5 are confirmed." / "Claims 6 and 7 are cancelled." ──
  let confirmed = grab(t, 'confirmed');
  if (!confirmed) {
    // "The patentability of claims X is confirmed." In a certificate this phrasing
    // is ALWAYS a confirmation (cancellations read "claims X are cancelled"), and
    // OCR routinely mangles "of" (->"ot"/"or") and drops the trailing "confirmed",
    // so we anchor on "patentability of claims X is/are" and treat the verb as
    // optional. The word "claim(s)" itself is also optional — OCR sometimes drops
    // it ("patentability of 1 is confirmed").
    const m = t.match(new RegExp(`patentability o[ftr]?\\s+(?:claims?\\s+)?${CLAIMS}\\s+(?:is|are)\\b`, 'i'));
    if (m) confirmed = tidy(m[1]);
  }
  let cancelled = grab(t, 'cancell?ed');
  let amended = grab(t, 'determined to be patentable as amended');
  if (!amended) {
    // Two-column-layout OCR often splits "...patentable as amended" by interleaving
    // claim-body text from the adjacent column, so match the claim list +
    // "determined to be patentable as" without requiring "amended" to follow.
    const m = t.match(new RegExp(`claims?\\s+${CLAIMS}\\s+(?:is|are)\\s+determined to be patentable as\\b`, 'i'));
    if (m) amended = tidy(m[1]);
    // Looser fallback: claim list ... as amended within one sentence.
    else { const m2 = t.match(new RegExp(`claims?\\s+${CLAIMS}\\b[^.]{0,40}as amended`, 'i')); if (m2) amended = tidy(m2[1]); }
  }
  // Claims held patentable BECAUSE they depend on an amended claim are also a
  // result of the amendment — include them in the amended group.
  {
    const md = t.match(new RegExp(`claims?\\s+${CLAIMS}\\s*,?\\s+dependent on an amended claim`, 'i'));
    if (md) amended = amended ? tidy(amended + ', ' + md[1]) : tidy(md[1]);
  }
  let added = '';
  let addM = t.match(new RegExp(`new claims?\\s+${CLAIMS}\\s+(?:is|are)\\s+added`, 'i'));
  // OCR often drops "claims" and/or "added": "New 29-122 ... determined to be
  // patentable". Anchor on "new" + claim numbers + a nearby added/determined.
  if (!addM) addM = t.match(new RegExp(`new\\s+(?:claims?\\s+)?${CLAIMS}\\b[^.]{0,30}(?:added|determined)`, 'i'));
  if (addM) added = tidy(addM[1]);

  // ── Form format (Notice of Intent to Issue Certificate / PTOL-465): the list
  //    FOLLOWS the label + colon, e.g. "patent claim(s) confirmed: 1-20". A blank
  //    field means "none", so an unmatched list simply leaves that category empty. ──
  const form = (label) => {
    const m = t.match(new RegExp(`claim\\(?s?\\)?\\s+${label}\\s*:?\\s*${CLAIMS}`, 'i'));
    return m ? tidy(m[1]) : '';
  };
  if (!confirmed) confirmed = form('confirmed');
  if (!cancelled) cancelled = form('cancell?ed');
  if (!amended) {
    const m = t.match(new RegExp(`claim\\(?s?\\)?\\s+amended[^:]{0,80}:\\s*${CLAIMS}`, 'i'));
    if (m) amended = tidy(m[1]);
  }
  if (!added) {
    const m = t.match(new RegExp(`newly presented claim\\(?s?\\)?\\s+patentable\\s*:?\\s*${CLAIMS}`, 'i'));
    if (m) added = tidy(m[1]);
  }

  if (!confirmed && !cancelled && !amended && !added) return null;

  const parts = [];
  if (confirmed) parts.push(`Confirmed ${confirmed}`);
  if (amended) parts.push(`Amended ${amended}`);
  if (added) parts.push(`New ${added}`);
  if (cancelled) parts.push(`Cancelled ${cancelled}`);
  return { confirmed, cancelled, amended, added, summary: parts.join(' · ') };
}

// Confirm a certificate actually belongs to THIS reexamination proceeding.
// Parties occasionally file another patent's certificate as an exhibit under the
// RXCERT code; such a document cites a different control number. We strip every
// non-digit from the text and look for this control number's digit run, which is
// tolerant of "/", ",", and OCR spaces ("90/016,049" / "90016049" all match).
// Returns true if the control number appears, false if readable text lacks it
// (likely another proceeding), or null when there is too little text to judge.
export function certCitesProceeding(text, appNum) {
  const num = String(appNum || '').replace(/\D/g, '');
  if (!num) return null;
  const digits = String(text || '').replace(/\D/g, '');
  if (digits.includes(num)) return true;
  const readable = String(text || '').replace(/\s/g, '').length;
  return readable >= 300 ? false : null;
}
