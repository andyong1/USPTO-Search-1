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

// True if the petition text invokes 35 U.S.C. 325(d) (the basis for asking the
// Office to reconsider the SNQ grant / terminate the proceeding).
export function detect325d(text) {
  if (!text) return false;
  return /\b325\s*\(\s*d\s*\)/i.test(text) || /section\s+325/i.test(text) || /35\s*u\.?\s*s\.?\s*c\.?\s*(?:§|section)?\s*325/i.test(text);
}

// Heuristic "is this the petition itself (vs. an exhibit)?" score from the PDF
// text. The petition cites the petition rules and uses request language; exhibits
// (prior-art references, claim charts, declarations) score low or negative.
export function petitionScore(text) {
  if (!text) return 0;
  const t = String(text).toLowerCase();
  let s = 0;
  if (/\bpetition\b/.test(t)) s += 1;
  if (/37\s*c\.?\s*f\.?\s*r\.?\s*(?:§|section)?\s*1\.18[0-9]/.test(t)) s += 3; // cites 1.181/1.182/1.183
  if (/respectfully\s+(?:request|submit|petition)/.test(t)) s += 2;
  if (/office\s+of\s+petitions/.test(t)) s += 1;
  if (/\b325\s*\(\s*d\s*\)/.test(t)) s += 2;
  if (/reconsider|terminat/.test(t)) s += 1;
  if (/exhibit|appendix|claim chart|declaration of/.test(t)) s -= 1;
  return s;
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
