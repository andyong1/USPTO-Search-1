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
// A bare slash always introduces a routing/client qualifier ("Fish & Richardson PC
// / Atmel"); law firm names do not contain one. Unlike SUFFIX this does not treat
// OCR "1" as a slash -- doing so unconditionally would corrupt names with digits.
const SLASH_TAIL = /\s*\/.*$/;
// A trailing parenthetical is an office or client code -- (DC), (SV), (TC), (J&J),
// (MAGIC LEAP), (US). Left in place these split one firm into a row per office.
// An unclosed one is the same qualifier with the closing bracket clipped off
// ("Vista IP Law Group, LLP (Magic Leap").
const PAREN_TAIL = /\s*\([^)]*(?:\)|$)\s*$/;
// A trailing " - QUALIFIER" is likewise an office or client ("DLA Piper LLP US -
// Reston", "Cabello Hall Zinda, PLLC - KPN"). Only applied when at least two words
// remain, so a genuinely hyphenated single-word name is left alone.
// Stray brackets are allowed in the tail because OCR leaves unmatched ones behind
// ("Volpe Koenig - AMI)"); the tail is a qualifier either way.
const DASH_TAIL = /^(.*?\S(?:\s+\S+)+?)\s*-\s*[A-Za-z0-9&.,'’()\[\] ]{1,30}$/;
// Everything past "d/b/a" is a trade name for the same entity, and the punctuation
// is written every possible way ("d.b.a.", "DBA", "D/B/A"), which alone split
// Flener IP Law across five keys.
const DBA_TAIL = /\s+D\s*[.\/]?\s*B\s*[.\/]?\s*A\s*[.\/]?(\s.*)?$/i;
// A "care of" prefix is mail routing; the firm is what FOLLOWS it. Stripped before
// SLASH_TAIL, which would otherwise cut the line at the slash in "c/o" and leave
// the key as a single letter. Requires the punctuation so a name simply beginning
// with "Co" is untouched.
const CARE_OF = /^c\s*[.\/]\s*o\s+/i;
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

/** Strip the routing suffix and office / client qualifiers from a raw line. */
function stripNoise(raw) {
  let t = String(raw || '').trim();
  // Iterate to a fixed point: qualifiers stack and nest -- "DLA PIPER LLP (US) -
  // Apple" only exposes its parenthetical once the dash tail is gone.
  for (let i = 0; i < 3; i++) {
    const before = t;
    t = t.replace(CARE_OF, '').replace(SUFFIX, '').replace(DBA_TAIL, '').replace(SLASH_TAIL, '').replace(PAREN_TAIL, '');
    const dash = t.match(DASH_TAIL);
    if (dash) t = dash[1];
    t = t.trim();
    if (t === before) break;
  }
  // A dangling comma or ampersand is where the cover sheet clipped the line.
  return t.replace(/\s+/g, ' ').replace(/[,&\s]+$/, '').trim();
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
  key = key.replace(/\s*&\s*/g, ' & '); // OCR drops the space: "GARRETT&DUNNER"
  key = key.replace(/\s+/g, ' ').trim();
  return { display, key };
}

/**
 * Curated spelling corrections, for the cases no rule can reach.
 *
 * The automatic passes handle truncation (prefix) and a one-word misreading
 * (token-aligned), and they deliberately let the corpus majority pick each
 * group's name. Two situations defeat that, and both need a human judgement:
 *
 *  - the misreading mangles a DIFFERENT NUMBER of words, so the token-aligned
 *    rule cannot see it: OCR reads "K&L Gates" as "KU Gates" (16 proceedings)
 *    and as bare "Gates" (10), none of which is a prefix or a one-word variant
 *    of another;
 *  - the corpus reads a name wrong MORE OFTEN than right, so majority naming
 *    labels the group with the error: "Cannichael IP" (4) outvotes the correct
 *    "Carmichael IP" (3).
 *
 * Keyed by the wrong key, valued with the firm's actual name. The corrected KEY
 * is derived by running that name through normalizeFirm, so this table never
 * states a key and a name that could drift apart. An entry both forces the merge
 * and overrides the label, so it wins regardless of the counts.
 *
 * Only firms whose real name is verifiable belong here. Where the correct
 * spelling is genuinely unknown -- "AVER IP" vs "AVEK IP", or a personal name
 * like "Peraira" vs "Pereira" -- the majority reading stands and the group is
 * left alone rather than guessed at.
 */
const FIRM_CORRECTIONS = new Map([
  // "&L" reads as "U", and the whole "K&L" drops out. Every bare-"GATES" row
  // carries a K&L office or client code (Chicago, Pittsburgh, BDX, Baxter),
  // which is what distinguishes them from the unrelated Kolitch Romano
  // Dascenzo Gates.
  ['KU GATES', 'K&L Gates LLP'],
  ['GATES', 'K&L Gates LLP'],
  // Same failure, different firm: everything before the last partner dropped out.
  ['BOCKIUS', 'Morgan, Lewis & Bockius LLP'],
  // "rn" reads as "nn".
  ['CANNICHAEL IP', 'Carmichael IP, PLLC'],
  // "GS" reads as "GEO".
  ['HODGEON RUSS', 'Hodgson Russ LLP'],
]);

/** Corrected canonical key -> the firm's actual name, for labelling. */
export function firmDisplayCorrections() {
  const out = new Map();
  for (const name of new Set(FIRM_CORRECTIONS.values())) out.set(normalizeFirm(name).key, name);
  return out;
}

/** Edit distance, bounded -- only ever called on two single words. */
function editDistance(a, b) {
  const m = a.length, n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

/**
 * True when two keys differ only by an OCR misreading of ONE word.
 *
 * Character-level OCR errors ("GODWIN PROCTER" for "GOODWIN PROCTER") cannot be
 * caught by the truncation rule, since neither key is a prefix of the other. But
 * comparing whole strings loosely would be dangerous, so the comparison is
 * token-ALIGNED: the two names must have the same number of words and agree on
 * every word but one. That structural requirement is what keeps genuinely
 * different entities apart -- "GODWIN PROCTER" is nowhere near "THE PROCTER &
 * GAMBLE COMPANY" under it, though a loose string similarity would flirt with it.
 *
 * The one differing word must be long enough to carry the comparison: initials
 * and connectors ("K" vs "L", "A" vs "B") are exactly where a one-character
 * difference distinguishes two real firms rather than misreading one.
 */
function isOcrVariant(a, b) {
  const at = a.split(' '), bt = b.split(' ');
  if (at.length !== bt.length) return false;
  let diffs = 0, at_i = -1;
  for (let i = 0; i < at.length; i++) if (at[i] !== bt[i]) { diffs++; at_i = i; }
  if (diffs !== 1) return false;
  const x = at[at_i], y = bt[at_i];
  // Both words must be purely alphabetic. A digit that differs is a VALUE, not a
  // misread character -- without this, the ZIP codes in address lines that leak
  // into the firm field merge two different addresses ("LONG CA 90802" with
  // "LONG CA 90806").
  if (!/^[A-Z]+$/.test(x) || !/^[A-Z]+$/.test(y)) return false;
  const minLen = Math.min(x.length, y.length);
  if (minLen < 4) return false;
  // Two characters of slack only on words long enough to absorb it.
  return editDistance(x, y) <= (minLen >= 6 ? 2 : 1);
}

/**
 * Collapse OCR-TRUNCATED variants of one firm onto a single key.
 *
 * The cover sheet clips long correspondent lines, so the same firm appears as
 * "FINNEGAN HENDERSON FARABOW", "... GARRETT &", and "... GARRETT & DUNNER".
 * No per-string normalization can fix this -- the missing words are absent from
 * the text -- so it has to be resolved across the corpus: a key that is a
 * word-boundary prefix of a longer key is the same firm, truncated. Left
 * unmerged, one firm lists as several rows with contradictory records.
 *
 * Deliberately conservative:
 *  - the prefix must end at a word boundary, so "COVINGTON & BURLING" is NOT
 *    merged into the misspelled "COVINGTON & BURLINGTON" (a real but rare miss,
 *    accepted to guarantee two distinct firms are never merged on a shared stem);
 *  - a key must have >= 2 words and >= 8 characters to be absorbed, keeping
 *    generic stems from swallowing unrelated firms;
 *  - where a key prefixes several unrelated longer keys the best-supported one
 *    wins, so the merge follows the evidence rather than string length alone.
 *
 * @param {Map<string, number>} keyCounts every key in the corpus and its volume.
 * @returns {Map<string, string>} key -> canonical key (identity where unmerged).
 */
export function canonicalizeFirmKeys(keyCounts) {
  const keys = [...keyCounts.keys()].filter(Boolean);
  const parent = new Map();
  for (const k of keys) {
    const words = k.split(' ').filter(Boolean);
    if (words.length < 2 || k.length < 8) { parent.set(k, k); continue; }
    let best = null, bestCount = -1;
    for (const l of keys) {
      if (l === k || l.length <= k.length) continue;
      if (!l.startsWith(k + ' ')) continue;
      const c = keyCounts.get(l) || 0;
      if (c > bestCount || (c === bestCount && best && l.length > best.length)) { best = l; bestCount = c; }
    }
    parent.set(k, best || k);
  }
  // Resolve chains (FARABOW -> GARRETT -> GARRETT & DUNNER) to a group id. Each
  // hop is strictly longer, so this terminates without a cycle check.
  const group = new Map();
  for (const k of keys) {
    let cur = k;
    for (let i = 0; i < keys.length; i++) {
      const p = parent.get(cur);
      if (!p || p === cur) break;
      cur = p;
    }
    group.set(k, cur);
  }
  // Name each group after its BEST-SUPPORTED member, not its longest. The longest
  // variant is usually the one with an address or client fragment welded on
  // ("PLUMSEA LAW GROUP LLC & SUITE F"), so length would name every group after
  // its noisiest spelling. Ties break toward the shorter key, which carries less
  // appended noise.
  const members = new Map();
  for (const [k, g] of group) {
    if (!members.has(g)) members.set(g, []);
    members.get(g).push(k);
  }
  const rep = new Map();
  for (const [g, ms] of members) {
    let best = ms[0];
    for (const m of ms) {
      const c = keyCounts.get(m) || 0, bc = keyCounts.get(best) || 0;
      if (c > bc || (c === bc && m.length < best.length)) best = m;
    }
    rep.set(g, best);
  }
  const out = new Map();
  for (const [k, g] of group) out.set(k, rep.get(g) || k);

  // Second pass: fold OCR misreadings of one word into the better-supported
  // spelling ("GODWIN PROCTER" -> "GOODWIN PROCTER"). Runs on the surviving
  // canonical keys, so a truncation and a typo in the same name resolve together.
  // Processed best-supported first, and only unabsorbed keys can absorb, so the
  // winner is always the spelling the corpus attests most -- never a chain that
  // drags a firm onto a misreading.
  const canonicals = [...new Set(out.values())];
  const weight = new Map();
  for (const [k, c] of out) weight.set(c, (weight.get(c) || 0) + (keyCounts.get(k) || 0));
  canonicals.sort((a, b) => (weight.get(b) - weight.get(a)) || a.localeCompare(b));
  const absorbedBy = new Map();
  for (const winner of canonicals) {
    if (absorbedBy.has(winner)) continue;
    for (const other of canonicals) {
      if (other === winner || absorbedBy.has(other)) continue;
      if (weight.get(other) > weight.get(winner)) continue;
      if (isOcrVariant(winner, other)) absorbedBy.set(other, winner);
    }
  }
  if (absorbedBy.size) {
    for (const [k, c] of out) out.set(k, absorbedBy.get(c) || c);
  }

  // Curated corrections last, so they override whatever the counts decided.
  // Applied to the original key AND to the group it landed in, since the wrong
  // spelling may itself have become a group's canonical name.
  for (const [k, c] of out) {
    const fix = FIRM_CORRECTIONS.get(c) || FIRM_CORRECTIONS.get(k);
    if (fix) out.set(k, normalizeFirm(fix).key);
  }
  return out;
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
  // A comma-separated list of surnames is the classic firm name, and it is the
  // shape that survives truncation: the cover sheet clips "FINNEGAN, HENDERSON,
  // FARABOW, GARRETT & DUNNER" mid-name, leaving no LLP and no trailing ampersand
  // to match on. Two or more commas is not a shape a person's name takes.
  if ((t.match(/,/g) || []).length >= 2) return 'firm';
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
