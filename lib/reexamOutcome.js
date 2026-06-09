// Best-effort extraction of the claim disposition from an ex parte reexamination
// certificate (RXCERT) or Notice of Intent to Issue a Reexam Certificate (RXNIRC).
// The USPTO API has no structured field for this, so we read the PDF text and
// pattern-match the standard certificate language, e.g.:
//   "Claims 1-5 are confirmed."
//   "Claims 6 and 7 are cancelled."
//   "Claims 8-10 are determined to be patentable as amended."
//   "New claims 11-15 are added and determined to be patentable."
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

// A claim list is digits/commas/dashes/spaces, optionally joined by "and".
const CLAIMS = '([0-9][0-9,\\s\\-]*(?:and\\s+[0-9][0-9,\\s\\-]*)*)';
const tidy = (s) => s.replace(/\s+/g, ' ').replace(/\s*,\s*/g, ', ').replace(/\s+and\s+/g, ' and ').trim().replace(/[.,\s]+$/, '');

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

  let confirmed = grab(t, 'confirmed');
  if (!confirmed) {
    const m = t.match(new RegExp(`patentability of claims?\\s+${CLAIMS}\\s+(?:is|are)\\s+confirmed`, 'i'));
    if (m) confirmed = tidy(m[1]);
  }
  const cancelled = grab(t, 'cancell?ed');
  const amended = grab(t, 'determined to be patentable as amended');
  let added = '';
  const addM = t.match(new RegExp(`new claims?\\s+${CLAIMS}\\s+(?:is|are)\\s+added`, 'i'));
  if (addM) added = tidy(addM[1]);

  if (!confirmed && !cancelled && !amended && !added) return null;

  const parts = [];
  if (confirmed) parts.push(`Confirmed ${confirmed}`);
  if (amended) parts.push(`Amended ${amended}`);
  if (added) parts.push(`New ${added}`);
  if (cancelled) parts.push(`Cancelled ${cancelled}`);
  return { confirmed, cancelled, amended, added, summary: parts.join(' · ') };
}
