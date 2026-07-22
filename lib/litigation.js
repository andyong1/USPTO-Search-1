// Extract related district-court litigation from an IPR petition's "Related
// Matters Under 37 C.F.R. § 42.8(b)(2)" section. Petitions phrase courts three
// ways — parenthetical shorthand "(E.D. Tex.)", bare CM/ECF codes "DED" in a case
// table, and long-form "the Eastern District of Texas" — so we detect all three,
// mapped to a common shorthand. We first ISOLATE the Related Matters section
// (litigation lives there; scanning the whole petition would grab case citations
// from the Fintiv / prior-art arguments), then split jurisdictions into those
// involving the petitioner vs. other parties on the same patent.
//
// Reflects what the petition disclosed AT FILING — not verified live pendency.
// Heuristic and precision-biased; some petitions name no court (only a case
// number) and are unextractable. All functions pure + unit-tested.

// Bluebook state abbreviations (enough to cover patent-heavy districts).
const STATE = {
  delaware: 'Del.', texas: 'Tex.', california: 'Cal.', 'new york': 'N.Y.', 'new jersey': 'N.J.',
  illinois: 'Ill.', massachusetts: 'Mass.', virginia: 'Va.', florida: 'Fla.', georgia: 'Ga.',
  washington: 'Wash.', colorado: 'Colo.', arizona: 'Ariz.', minnesota: 'Minn.', wisconsin: 'Wis.',
  michigan: 'Mich.', 'north carolina': 'N.C.', 'south carolina': 'S.C.', utah: 'Utah', oregon: 'Or.',
  nevada: 'Nev.', ohio: 'Ohio', pennsylvania: 'Pa.', indiana: 'Ind.', tennessee: 'Tenn.',
  missouri: 'Mo.', maryland: 'Md.', connecticut: 'Conn.', 'new hampshire': 'N.H.', kansas: 'Kan.',
  louisiana: 'La.', alabama: 'Ala.', kentucky: 'Ky.', oklahoma: 'Okla.', iowa: 'Iowa', nebraska: 'Neb.',
  'rhode island': 'R.I.', idaho: 'Idaho', maine: 'Me.', arkansas: 'Ark.', mississippi: 'Miss.',
  'new mexico': 'N.M.', hawaii: 'Haw.', columbia: 'D.C.', wyoming: 'Wyo.', montana: 'Mont.',
  alaska: 'Alaska', vermont: 'Vt.', 'north dakota': 'N.D.', 'south dakota': 'S.D.',
  'west virginia': 'W. Va.',
};
const DIR = { northern: 'N.D.', southern: 'S.D.', eastern: 'E.D.', western: 'W.D.', central: 'C.D.', middle: 'M.D.' };
// Reverse lookup: lowercased Bluebook state abbrev -> its canonical form ("del." -> "Del.").
const ABBREV_CANON = {};
for (const v of Object.values(STATE)) ABBREV_CANON[v.toLowerCase()] = v;

// Letters-only state lookup for the generic district parser: Bluebook abbrevs
// ("TEX" -> "Tex."), full names ("TEXAS", "NEWYORK"), and USPS codes ("TX").
const POSTAL = {
  DE: 'delaware', TX: 'texas', CA: 'california', NY: 'new york', NJ: 'new jersey', IL: 'illinois',
  MA: 'massachusetts', VA: 'virginia', FL: 'florida', GA: 'georgia', WA: 'washington', CO: 'colorado',
  AZ: 'arizona', MN: 'minnesota', WI: 'wisconsin', MI: 'michigan', NC: 'north carolina', SC: 'south carolina',
  UT: 'utah', OR: 'oregon', NV: 'nevada', OH: 'ohio', PA: 'pennsylvania', IN: 'indiana', TN: 'tennessee',
  MO: 'missouri', MD: 'maryland', CT: 'connecticut', NH: 'new hampshire', KS: 'kansas', LA: 'louisiana',
  AL: 'alabama', KY: 'kentucky', OK: 'oklahoma', IA: 'iowa', NE: 'nebraska', RI: 'rhode island',
  ID: 'idaho', ME: 'maine', AR: 'arkansas', MS: 'mississippi', NM: 'new mexico', HI: 'hawaii',
  WY: 'wyoming', MT: 'montana', AK: 'alaska', VT: 'vermont', ND: 'north dakota',
  SD: 'south dakota', WV: 'west virginia',
};
const STATE_LETTERS = {};
for (const [name, ab] of Object.entries(STATE)) {
  STATE_LETTERS[ab.toUpperCase().replace(/[^A-Z]/g, '')] = ab;   // "TEX" -> "Tex."
  STATE_LETTERS[name.toUpperCase().replace(/[^A-Z]/g, '')] = ab; // "TEXAS" -> "Tex."
}
for (const [code, name] of Object.entries(POSTAL)) {
  if (!STATE_LETTERS[code] && STATE[name]) STATE_LETTERS[code] = STATE[name]; // "TX" -> "Tex."
}
// Compose direction + state abbrev per Bluebook: multi-initial states join
// without a space ("E.D.N.Y."), word abbrevs with one ("E.D. Tex.").
function composeCourt(dirLetter, st) {
  if (st === 'D.C.') return 'D.D.C.';
  const d = dirLetter ? `${dirLetter}.D.` : 'D.';
  return /^([A-Z]\.)+$/.test(st) ? `${d}${st}` : `${d} ${st}`;
}
// States with exactly one federal district — only these can be inferred from a
// bare state name ("the Delaware Action" -> D. Del.). "the Texas Litigation"
// is ambiguous (N/S/E/W.D. Tex.) and must NOT produce a district.
const SINGLE_DISTRICT = new Set(['Del.', 'N.J.', 'Mass.', 'Md.', 'Conn.', 'Minn.', 'Colo.',
  'Ariz.', 'Utah', 'Or.', 'Nev.', 'Kan.', 'N.H.', 'R.I.', 'Idaho', 'Me.', 'N.M.', 'Haw.',
  'Neb.', 'S.C.', 'D.C.', 'Wyo.', 'Mont.', 'Alaska', 'Vt.', 'N.D.', 'S.D.']);

// Parenthetical/reporter shorthand + CM/ECF court codes -> canonical shorthand.
const COURT_MAP = {
  DDEL: 'D. Del.', DDE: 'D. Del.', DED: 'D. Del.',
  EDTEX: 'E.D. Tex.', TXED: 'E.D. Tex.', EDTX: 'E.D. Tex.',
  WDTEX: 'W.D. Tex.', TXWD: 'W.D. Tex.', WDTX: 'W.D. Tex.',
  NDTEX: 'N.D. Tex.', TXND: 'N.D. Tex.', NDTX: 'N.D. Tex.',
  SDTEX: 'S.D. Tex.', TXSD: 'S.D. Tex.', SDTX: 'S.D. Tex.',
  NDCAL: 'N.D. Cal.', CAND: 'N.D. Cal.', NDCA: 'N.D. Cal.', CDCAL: 'C.D. Cal.', CACD: 'C.D. Cal.', CDCA: 'C.D. Cal.',
  SDCAL: 'S.D. Cal.', CASD: 'S.D. Cal.', SDCA: 'S.D. Cal.', EDCAL: 'E.D. Cal.', CAED: 'E.D. Cal.', EDCA: 'E.D. Cal.',
  SDNY: 'S.D.N.Y.', NYSD: 'S.D.N.Y.', EDNY: 'E.D.N.Y.', NYED: 'E.D.N.Y.',
  DNJ: 'D.N.J.', NJD: 'D.N.J.', NDILL: 'N.D. Ill.', ILND: 'N.D. Ill.',
  DMASS: 'D. Mass.', MAD: 'D. Mass.', EDVA: 'E.D. Va.', VAED: 'E.D. Va.',
  SDFLA: 'S.D. Fla.', FLSD: 'S.D. Fla.', MDFLA: 'M.D. Fla.', FLMD: 'M.D. Fla.',
  NDGA: 'N.D. Ga.', GAND: 'N.D. Ga.', WDWASH: 'W.D. Wash.', WAWD: 'W.D. Wash.',
  DCOLO: 'D. Colo.', COD: 'D. Colo.', DARIZ: 'D. Ariz.', AZD: 'D. Ariz.',
  DMINN: 'D. Minn.', MND: 'D. Minn.', WDWIS: 'W.D. Wis.', WIWD: 'W.D. Wis.',
  EDMICH: 'E.D. Mich.', MIED: 'E.D. Mich.', WDNC: 'W.D.N.C.', NCWD: 'W.D.N.C.',
  EDNC: 'E.D.N.C.', NCED: 'E.D.N.C.', DUTAH: 'D. Utah', UTD: 'D. Utah',
  DOR: 'D. Or.', ORD: 'D. Or.', DNEV: 'D. Nev.', NVD: 'D. Nev.', DDC: 'D.D.C.', DCD: 'D.D.C.',
};
export function normCourt(token) {
  const key = String(token || '').toUpperCase().replace(/[^A-Z]/g, '');
  if (COURT_MAP[key]) return COURT_MAP[key];
  // Generic fallback — [direction]D + any state spelling ("NDOHIO", "SDTEXAS",
  // "EDMO", "WDWA"), so districts don't each need a COURT_MAP entry. A missing
  // direction is only valid for single-district states.
  const m = key.match(/^([NSEWMC]?)D([A-Z]{2,14})$/);
  if (m && STATE_LETTERS[m[2]] && (m[1] || SINGLE_DISTRICT.has(STATE_LETTERS[m[2]]))) {
    return composeCourt(m[1], STATE_LETTERS[m[2]]);
  }
  return null;
}
// Compose a long-form "(direction) District of <state>" into shorthand.
function longToShorthand(dirWord, stateWords) {
  const words = String(stateWords || '').toLowerCase().trim();
  // The caller's regex may over-capture a trailing word ("Delaware Case No…" ->
  // "delaware case"); fall back to the first word when the full phrase misses.
  const st = STATE[words] || STATE[words.split(/\s+/)[0]];
  if (!st) return null;
  const d = DIR[String(dirWord || '').toLowerCase()];
  // "District of Texas" with no direction is not a court — it's usually a
  // direction word severed by an interleaved page header. Only single-district
  // states may omit the direction.
  if (!d && !SINGLE_DISTRICT.has(st)) return null;
  return composeCourt(d ? d[0] : '', st);
}

const CORP = new Set(['the', 'inc', 'llc', 'llp', 'lp', 'co', 'corp', 'corporation',
  'company', 'ltd', 'limited', 'gmbh', 'ag', 'sa', 'plc', 'holdings', 'holding', 'and']);
export function petitionerToken(name) {
  for (const w of String(name || '').split(/[^A-Za-z0-9]+/)) {
    const lw = w.toLowerCase();
    if (lw.length >= 3 && !CORP.has(lw)) return lw;
  }
  return '';
}

// Isolate the Related Matters section: from its BODY heading (skipping table-of-
// contents entries, which have dot leaders) to the next section heading. Returns
// { section, found } — found=false means no clean heading, so `section` is a
// bounded front-matter slice and the caller applies a stricter guard.
export function sliceRelatedMatters(text) {
  const all = sliceRelatedMattersAll(text);
  return all[0];
}
// ALL candidate sections, best-first: tier-1 heads ("Related Matters" /
// §42.8(b)(2) cite) before tier-2 prose anchors ("related district court…",
// which also appears in Fintiv argument — but the Fintiv discussion DESCRIBES
// the co-pending litigation, so it's a legitimate last resort when the real
// section names no court). Last entry is the found=false front slice.
export function sliceRelatedMattersAll(text) {
  const t = String(text || '').replace(/\s+/g, ' ');
  const heads = [
    // §42.8(B)(1)-(4)-style RANGE headings (Samsung petitions put Mandatory
    // Notices at the end under that citation, with no "Related Matters" line).
    ...t.matchAll(/related\s+matters?|42\.8\s*\(\s*b\s*\)\s*\(\s*2\s*\)|42\.8\s*\(\s*b\s*\)\s*\(\s*1\s*\)\s*[-–—]/gi),
    ...t.matchAll(/related\s+district[- ]court|other\s+proceedings|mandatory\s+notices/gi),
  ];
  // Section end: the next mandatory-notices subsection / heading.
  const endRe = /\b(lead\s+and\s+back|lead\s+counsel|back-?up\s+counsel|counsel\s+and\s+service|service\s+information|grounds?\s+for\s+standing|certification\s+of\s+grounds|standing\s+under|statement\s+of\s+precise|precise\s+relief|fee\s+payment|payment\s+of\s+fees|power\s+of\s+attorney|following\s+counsel)\b/i;
  const subRe = /42\.8\s*\(\s*b\s*\)\s*\(\s*[3-9]\s*\)/i;
  const out = [];
  for (const h of heads.slice(0, 8)) {
    const ahead = t.slice(h.index, h.index + 140);
    if (/\.\s?\.\s?\.\s?\./.test(ahead)) continue; // TOC dot-leaders
    const rest = t.slice(h.index + 8);
    const ends = [rest.match(endRe), rest.match(subRe)].filter(Boolean).map((m) => m.index);
    // Cap well above the longest real-world case list (IPR2025-00718's runs
    // past 3,000 chars); endRe/subRe still bound normal sections tightly.
    const end = ends.length ? Math.min(Math.min(...ends), 8500) : 8500;
    out.push({ section: t.slice(h.index, h.index + 8 + end), found: true });
  }
  if (!out.length) out.push({ section: t.slice(0, 22000), found: false });
  return out;
}

// What to STORE as petition front-matter (so litigation can be re-parsed without
// re-downloading): a window around the Related Matters section located in the
// FULL petition — the section can sit well past the front (some petitions run the
// technical argument first). Prefers the occurrence actually followed by a case
// (a "v." with a court or civil-action number). Falls back to a front prefix.
//
// The authoritative extraction runs on the FULL petition text at fetch time; this
// window exists only so the extractor can be re-run cheaply later (?litrescan=1)
// without re-downloading. It is sized generously (~23KB) so a re-parse reproduces
// what full-text extraction found, including long multi-case lists and sections
// that sit deep in the petition — TOAST-compresses to a few KB on disk.
const FM_BACK = 500, FM_FWD = 23000; // stored-window span around the anchor
export function petitionFrontmatter(fullText) {
  const t = String(fullText || '').replace(/\s+/g, ' ');
  // Real headings outrank prose anchors — "related district court…" also appears
  // in Fintiv/§314(a) argument and used to steal the stored window from the
  // actual Related Matters section.
  const tiers = [
    /related\s+matters?|42\.8\s*\(\s*b\s*\)\s*\(\s*2\s*\)|42\.8\s*\(\s*b\s*\)\s*\(\s*1\s*\)\s*[-–—]/gi,
    /related\s+district[- ]court|other\s+proceedings|mandatory\s+notices/gi,
  ];
  const cands = [];
  for (const re of tiers) {
    let m;
    while ((m = re.exec(t))) {
      if (/\.\s?\.\s?\.\s?\./.test(t.slice(m.index, m.index + 140))) continue; // skip TOC
      cands.push(m.index);
    }
  }
  const window = (i) => t.slice(Math.max(0, i - FM_BACK), i + FM_FWD);
  for (const i of cands) {
    const win = t.slice(i, i + 2600);
    if (/\bv\.?\s/i.test(win) && (/\d{1,2}[:-]\d{2}-cv-?\d{2,6}/.test(win) || /district of|[NSEWMC]\.?\s?D\.?\s?[A-Z]/i.test(win))) return window(i);
  }
  return cands.length ? window(cands[0]) : t.slice(0, FM_BACK + FM_FWD);
}

// All district-court jurisdictions named in a chunk of text, as canonical
// shorthands, with the character index of each hit (for petitioner proximity).
function courtHits(chunk) {
  const hits = [];
  let m;
  // A) Parenthetical shorthand/code — "(D. Del.)", "(E.D. Tex.)", "(S.D.N.Y.)", "(DDE)".
  //    Content may trail off ("(D. Del. Filed Sep. 01, 2022)", "(E.D. of Texas)",
  //    "(N.D. Ohio Sept. 3, 2024)") — retry on the leading tokens, "of" dropped.
  const paren = /\(([^)]{2,60})\)/g;
  while ((m = paren.exec(chunk))) {
    let c = normCourt(m[1]);
    if (!c) {
      const toks = m[1].trim().split(/\s+/).filter((w) => /[A-Za-z]/.test(w) && !/^of$/i.test(w));
      c = normCourt(toks.slice(0, 2).join('')) || normCourt(toks.slice(0, 3).join(''));
      // Bare state in the paren — "(Del. , July 17, 2018)" — counts as its plain
      // district ONLY when a federal civil-action number closely precedes it AND
      // the state has a single district (multi-district states are ambiguous).
      if (!c) {
        const st = STATE_LETTERS[String(toks[0] || '').toUpperCase().replace(/[^A-Z]/g, '')];
        if (st && SINGLE_DISTRICT.has(st) && /-cv-?\d/i.test(chunk.slice(Math.max(0, m.index - 120), m.index))) c = composeCourt('', st);
      }
    }
    if (c) hits.push({ court: c, at: m.index });
  }
  // B) Long-form: "(Northern) District of Delaware".
  const long = /\b(Northern|Southern|Eastern|Western|Central|Middle)?\s*District\s+of\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/g;
  while ((m = long.exec(chunk))) { const c = longToShorthand(m[1], m[2]); if (c) hits.push({ court: c, at: m.index }); }
  // C) Bare court codes as standalone tokens — "… 1-15-cv-00271 EDTX" / "DED".
  // Built from every COURT_MAP key so table-style codes are caught reliably.
  const ecf = new RegExp('\\b(' + Object.keys(COURT_MAP).join('|') + ')\\b', 'g');
  while ((m = ecf.exec(chunk))) { const c = normCourt(m[1]); if (c) hits.push({ court: c, at: m.index }); }
  // D) Direction-prefixed reporter shorthand in prose (non-parenthetical) —
  //    "in the E.D. Tex.", "W.D. Texas", "N.D. Ohio".
  const rep = /\b([NSEWMC]\.?\s?D\.?\s?[A-Z][A-Za-z]{1,11}\.?)/g;
  while ((m = rep.exec(chunk))) { const c = normCourt(m[1]); if (c) hits.push({ court: c, at: m.index }); }
  // D2) Bare "D. <state abbrev>" with no direction — case tables write
  //     "…1-22-cv-00915 D. Del. July 11, 2022". Requires the literal dot after D
  //     and a known state abbreviation, so ordinary prose can't match.
  const bareAbbrev = [...new Set(Object.values(STATE))].map((a) => a.replace(/\./g, '\\.')).join('|');
  const bareD = new RegExp('(?<![NSEWMC]\\.\\s?)\\bD\\.\\s?(' + bareAbbrev + ')(?![A-Za-z])', 'g');
  while ((m = bareD.exec(chunk))) {
    const st = ABBREV_CANON[m[1].toLowerCase()];
    if (st && SINGLE_DISTRICT.has(st)) hits.push({ court: composeCourt('', st), at: m.index });
  }
  // E) "Dist. Del." / "Eastern Dist. of Tex." — "Dist." + a Bluebook state abbrev
  //    (some petitions write the parenthetical this way instead of "D. Del.").
  const abbrevAlt = [...new Set(Object.values(STATE))].map((a) => a.replace(/\./g, '\\.')).join('|');
  const dist = new RegExp('\\b(Northern|Southern|Eastern|Western|Central|Middle)?\\s*Dist\\.?\\s+(?:of\\s+)?(' + abbrevAlt + ')(?![A-Za-z])', 'gi');
  while ((m = dist.exec(chunk))) {
    const st = ABBREV_CANON[m[2].toLowerCase()];
    if (!st) continue;
    const d = DIR[String(m[1] || '').toLowerCase()];
    if (!d && !SINGLE_DISTRICT.has(st)) continue;
    hits.push({ court: composeCourt(d ? d[0] : '', st), at: m.index });
  }
  return hits;
}

// The case caption a court mention belongs to. A court almost always TRAILS its
// caption ("Caption Number COURT" tables, "Caption, No. X (COURT)"), so take the
// nearest PRECEDING "X v. Y"; fall back to the nearest FOLLOWING caption only when
// there's none before (list-heading courts stated ahead of their cases). Tight
// window so an adjacent case's parties don't bleed in. Returns the caption, or null.
function nearestCaption(section, at) {
  const W = 200;
  const before = section.slice(Math.max(0, at - W), at);
  const bs = [...before.matchAll(/\sv\.?\s/gi)];
  let vpos = bs.length ? Math.max(0, at - W) + bs[bs.length - 1].index : -1;
  if (vpos < 0) {
    const a = section.slice(at, at + W).match(/\sv\.?\s/i);
    if (a) vpos = at + a.index;
  }
  return vpos < 0 ? null : section.slice(Math.max(0, vpos - 55), vpos + 55);
}

// pdf-parse interleaves the running page header/footer into the text stream —
// e.g. "Attorney Docket No. 49649-0056IP1 IPR of U.S. Patent No. 11,932,230 72" —
// which can land in the MIDDLE of a case caption ("Bulletproof Property [header]
// Management, LLC v. Tesla"), pushing the plaintiff out of the caption window so
// the patent-owner guard fails. Strip that docket-anchored boilerplate.
function stripRunningHeaders(text) {
  return String(text).replace(
    /Attorney Docket No\.?\s*\S{3,24}?\s+[^]{0,80}?Patent No\.?\s*[\d,]{5,}\s*\d{0,4}/gi,
    ' '
  );
}

export function extractRelatedLitigation(text, petitionerName, poName) {
  const raw = stripRunningHeaders(String(text || '').replace(/\s+/g, ' '));
  const petTok = petitionerToken(petitionerName);
  const poTok = petitionerToken(poName);

  // Try candidate sections best-first; the first that yields any court wins.
  // (The real Related Matters section sometimes names only a case number — the
  // Fintiv discussion of the co-pending litigation is then the fallback, under
  // the same guards.)
  for (const { section, found } of sliceRelatedMattersAll(raw)) {
    let r = extractFromSection(section, found, petTok, poTok);
    if (!r.petitioner.length && !r.other.length && found && poTok) {
      // PO-of-record can differ from the asserting entity in the captions
      // (IPR2025-00718: PTAB says "MES, Inc.", the cases say "Midwest Energy
      // Emissions Corp."). If MULTIPLE captions share a plaintiff token, that
      // dominant plaintiff is the de-facto patent owner — a lone stray
      // authority citation can never produce one.
      const dom = dominantPlaintiffToken(section);
      if (dom && dom !== poTok) r = extractFromSection(section, found, petTok, dom);
    }
    if (r.petitioner.length || r.other.length) return r;
  }
  return { petitioner: [], other: [] };
}

// The token shared by the plaintiff side of >=2 captions near court hits in a
// section, or '' if none. Tokens are deduped per caption so one caption can't
// vote twice; min length 4 keeps OCR shrapnel out.
function dominantPlaintiffToken(section) {
  const counts = {};
  const capsSeen = new Set(); // multiple detector branches can hit the SAME
  for (const { at } of courtHits(section)) { // mention — one caption, one vote
    const cap = nearestCaption(section, at);
    if (!cap || capsSeen.has(cap)) continue;
    capsSeen.add(cap);
    const v = cap.search(/\sv\.?\s/i);
    if (v <= 0) continue;
    const seen = new Set();
    for (const w of cap.slice(0, v).split(/[^A-Za-z0-9]+/)) {
      const lw = w.toLowerCase();
      if (lw.length >= 4 && !CORP.has(lw) && !seen.has(lw)) { seen.add(lw); counts[lw] = (counts[lw] || 0) + 1; }
    }
  }
  let best = '', n = 0;
  for (const [t, c] of Object.entries(counts)) if (c > n) { best = t; n = c; }
  return n >= 2 ? best : '';
}

function extractFromSection(section, found, petTok, poTok) {
  const petSet = new Set(), otherSet = new Set();

  for (const { court, at } of courtHits(section)) {
    // Related litigation on the patent names the PATENT OWNER as a party (they
    // assert it, or are the DJ defendant). Requiring the PO in the court's OWN
    // nearest caption filters stray case citations — claim-construction / Fintiv
    // authorities that mention a court but not the PO (e.g. an unrelated M.D. Fla.
    // Markman order). If the PO name is unknown, fall back to a caption/number guard.
    let ctx;
    if (poTok) {
      const cap = nearestCaption(section, at);
      if (cap) {
        if (!cap.toLowerCase().includes(poTok)) continue;
        ctx = cap.toLowerCase();
      } else {
        // No caption at all near the court — prose-style disclosure ("lawsuit
        // brought by the assignee … against T-Mobile … (E.D. Tex.)"). Fall back
        // to a wider window, still requiring the PO to be named in it (stray
        // authority citations have their own captions, so they don't get here).
        const near = section.slice(Math.max(0, at - 300), at + 300).toLowerCase();
        if (!near.includes(poTok)) continue;
        ctx = near;
      }
    } else {
      const near = section.slice(Math.max(0, at - 300), at + 300);
      if (!found && !/\bv\.?\s/i.test(near) && !/\b\d{1,2}[:-]\d{2}-cv-?\d{2,6}/i.test(near)) continue;
      ctx = near.toLowerCase();
    }
    (petTok && ctx.includes(petTok) ? petSet : otherSet).add(court);
  }
  // A district can host BOTH a petitioner case and a separate case against another
  // party (e.g. Damaka v. Cisco AND Damaka v. Cigna, both E.D. Tex.) — so a court
  // may legitimately appear in both columns; do NOT subtract petitioner from other.
  return { petitioner: [...petSet].sort(), other: [...otherSet].sort() };
}
