// Law-firm attribution for reexamination proceedings.
//
// Both sides come from ONE document we already OCR: the determination's PTOL-90A
// cover sheet. It carries two distinct correspondence blocks --
//
//   7590
//   GOODWIN PROCTER LLP / PTAB          <- the PATENT OWNER's correspondence
//   100 NORTHERN AVENUE
//
//   (THIRD PARTY REQUESTER'S CORRESPONDENCE ADDRESS)
//   KLARQUIST SPARKMAN, LLP (IPR/Reexam) <- the REQUESTER's counsel
//
// -- and it is the same document that records the outcome (order vs denial), so
// firm and result are read from a single source with no extra API calls.
//
// Confirmed against ODP `recordAttorney` on 90016155: the 7590 block matches the
// power-of-attorney firm exactly, and the requester block names a different firm.
// Getting these two blocks backwards would invert every statistic, so they are
// extracted by their own labels and never by position.

// Everything after these markers is a mail-stop / department routing suffix, not
// part of the firm name. OCR frequently renders "/" as "1" or "|".
const SUFFIX = /\s*[\/|1]\s*(PTAB|IPR|REEXAM|SILICON VALLEY|PATENT ADMINISTRATOR|IP GROUP|PATENT DEPT).*$/i;
const ENTITY_TAIL = /[\s,]+(L\.?\s?L\.?\s?P\.?|P\.?\s?L\.?\s?L\.?\s?C\.?|P\.?\s?C\.?|P\.?\s?A\.?|LLC|LTD|INC|CHARTERED)\s*\.?\s*$/i;

// A line that is an address, not a name.
const ADDRESSY = /^\s*(\d|SUITE\b|STE\b|FLOOR\b|FL\b|P\.?\s?O\.?\s+BOX|ONE\s|TWO\s|THREE\s)/i;

// PTOL-90A prints the correspondence address in a left column and
// EXAMINER / ART UNIT / MAIL DATE in a right column. OCR sometimes interleaves
// the two, so the line after 7590 can be a right-column LABEL rather than the
// firm. Those cases are unrecoverable (the firm name is simply absent from the
// text) and must be reported as "no firm" rather than recorded as a firm named
// "EXAMINER" -- silently accepting them would invent firms out of layout noise.
const COVER_LABEL = /^(EXAMINER|ART\s*UNIT|MAIL\s*DATE|PAPER\s*NUMBER|DELIVERY\s*MODE|NOTIFICATION\s*DATE|CONFIRMATION\s*NO|FIRST\s*NAMED\s*INVENTOR|ATTORNEY\s*DOCKET\s*NO|APPLICATION\s*NO|FILING\s*DATE|PATENT\s*NO|TITLE|PERIOD\s*FOR\s*REPLY|DATE\s*MAILED)\b/i;

/** True when a candidate line is a cover-sheet label, not a correspondent name. */
export function isCoverLabel(line) {
  return COVER_LABEL.test(String(line || '').trim());
}

/** Strip the routing suffix and parenthetical practice-group notes from a raw line. */
function stripNoise(raw) {
  let t = String(raw || '').trim();
  t = t.replace(SUFFIX, '');
  t = t.replace(/\s*\((?:IPR|REEXAM|TC|PTAB)[^)]*\)\s*$/i, ''); // "(IPR/Reexam)", "(TC)"
  return t.replace(/\s+/g, ' ').trim();
}

/**
 * Normalize a raw correspondence line into a stable grouping key plus a display
 * name. The key drops punctuation and the entity suffix so that
 * "GOODWIN PROCTER LLP / PTAB", "Goodwin Procter LLP", and the OCR variant
 * "GOODWIN PROCTER LLP 1 PTAB" all collapse to one firm.
 */
export function normalizeFirm(raw) {
  const display = stripNoise(raw);
  if (!display) return { display: '', key: '' };
  let key = display.toUpperCase();
  key = key.replace(ENTITY_TAIL, '');
  key = key.replace(/\bAND\b/g, '&');
  key = key.replace(/[.,;:'"()]/g, ' ');
  key = key.replace(/\s+/g, ' ').trim();
  return { display, key };
}

/**
 * Who filed: an actual law firm, a self-representing party / filing service, or
 * an individual practitioner. Heuristic by construction -- the correspondence
 * block does not say which it is -- so it exists to let a page GROUP these
 * rather than to be authoritative. 'other' is the honest default.
 */
export function classifyFiler(raw) {
  const t = stripNoise(raw).toUpperCase();
  if (!t) return 'other';
  // Practice markers that only a firm carries.
  if (/\b(LLP|PLLC|P\.?\s?C\.?|LAW|ATTORNEY|COUNSEL|LEGAL|INTELLECTUAL PROPERTY|PATENT GROUP|IP GROUP|IP LAW)\b/.test(t)) return 'firm';
  if (/&/.test(t) || /\bAND\b/.test(t)) return 'firm';        // "Haynes and Boone", "Fish & Richardson"
  if (/\bIP\b/.test(t)) return 'firm';                        // "Erise IP", "Horizon IP"
  // Corporate/service entities that appear as their own correspondent.
  if (/\b(INC|CORP|CORPORATION|COMPANY|TECHNOLOGIES|HOLDINGS|VENTURES|FILING|SERVICES|SOLUTIONS|PATENTS)\b/.test(t)) return 'other';
  if (/\bLLC\b/.test(t)) return 'other';                      // bare LLC without a practice marker
  // Two or three capitalized words and nothing else reads as a person.
  const words = t.split(' ').filter(Boolean);
  if (words.length <= 3 && !/\d/.test(t)) return 'individual';
  return 'other';
}

/**
 * Pull both correspondence blocks out of a determination's OCR text.
 * Returns { ownerRaw, requesterRaw, customerNumber } with nulls where absent
 * (a patent-owner-requested reexam has no third-party requester block at all).
 */
export function extractFirmBlocks(text) {
  const lines = String(text || '').split(/\r?\n/);
  // The first line after the marker that reads as a correspondent name. Stops at
  // a cover-sheet label rather than skipping past it: once the right column has
  // bled in, later lines belong to that column too, so continuing would attach
  // an unrelated name (an examiner's) to the firm field.
  const firstNameLine = (start, span) => {
    for (let j = start; j < Math.min(start + span, lines.length); j++) {
      const l = lines[j].trim();
      if (!l || ADDRESSY.test(l)) continue;
      if (/^\(/.test(l)) continue;
      if (isCoverLabel(l)) return null;
      return l;
    }
    return null;
  };

  let ownerRaw = null, requesterRaw = null;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim();
    // The owner block is introduced by a bare 7590 on its own line.
    if (ownerRaw === null && /^7590$/.test(l)) ownerRaw = firstNameLine(i + 1, 4);
    // The requester block is explicitly labelled (apostrophe optional in OCR).
    if (requesterRaw === null && /\(\s*THIRD\s+PARTY\s+REQUESTER'?S?\s+CORRESPONDENCE\s+ADDRESS\s*\)/i.test(l)) {
      requesterRaw = firstNameLine(i + 1, 4);
    }
  }
  // Deliberately no customer number: the header digits are ambiguous (a patent
  // number OCR'd nearby scored as a 7-digit "customer number" in testing), and
  // ODP's applicationMetaData.customerNumber is authoritative when we want it.
  return { ownerRaw, requesterRaw };
}
