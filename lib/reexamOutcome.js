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
  const t = String(text).replace(/\s+/g, ' ');

  // ── Prose format (final certificate): the list PRECEDES the verb, e.g.
  //    "Claims 1-5 are confirmed." / "Claims 6 and 7 are cancelled." ──
  let confirmed = grab(t, 'confirmed');
  if (!confirmed) {
    const m = t.match(new RegExp(`patentability of claims?\\s+${CLAIMS}\\s+(?:is|are)\\s+confirmed`, 'i'));
    if (m) confirmed = tidy(m[1]);
  }
  let cancelled = grab(t, 'cancell?ed');
  let amended = grab(t, 'determined to be patentable as amended');
  if (!amended) {
    // Common alternate phrasing: "Claims X, as amended, are determined to be patentable."
    const m = t.match(new RegExp(`claims?\\s+${CLAIMS}[\\s,]*as amended`, 'i'));
    if (m) amended = tidy(m[1]);
  }
  let added = '';
  const addM = t.match(new RegExp(`new claims?\\s+${CLAIMS}\\s+(?:is|are)\\s+added`, 'i'));
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
