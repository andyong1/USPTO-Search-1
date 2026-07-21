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
  'new mexico': 'N.M.', hawaii: 'Haw.', columbia: 'D.C.',
};
const DIR = { northern: 'N.D.', southern: 'S.D.', eastern: 'E.D.', western: 'W.D.', central: 'C.D.', middle: 'M.D.' };
// Reverse lookup: lowercased Bluebook state abbrev -> its canonical form ("del." -> "Del.").
const ABBREV_CANON = {};
for (const v of Object.values(STATE)) ABBREV_CANON[v.toLowerCase()] = v;

// Parenthetical/reporter shorthand + CM/ECF court codes -> canonical shorthand.
const COURT_MAP = {
  DDEL: 'D. Del.', DDE: 'D. Del.', DED: 'D. Del.',
  EDTEX: 'E.D. Tex.', TXED: 'E.D. Tex.', EDTX: 'E.D. Tex.',
  WDTEX: 'W.D. Tex.', TXWD: 'W.D. Tex.', WDTX: 'W.D. Tex.',
  NDTEX: 'N.D. Tex.', TXND: 'N.D. Tex.', NDTX: 'N.D. Tex.',
  SDTEX: 'S.D. Tex.', TXSD: 'S.D. Tex.', SDTX: 'S.D. Tex.',
  NDCAL: 'N.D. Cal.', CAND: 'N.D. Cal.', CDCAL: 'C.D. Cal.', CACD: 'C.D. Cal.',
  SDCAL: 'S.D. Cal.', CASD: 'S.D. Cal.', EDCAL: 'E.D. Cal.', CAED: 'E.D. Cal.',
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
  return COURT_MAP[key] || null;
}
// Compose a long-form "(direction) District of <state>" into shorthand.
function longToShorthand(dirWord, stateWords) {
  const st = STATE[String(stateWords || '').toLowerCase().trim()];
  if (!st) return null;
  if (st === 'D.C.') return 'D.D.C.';
  const d = DIR[String(dirWord || '').toLowerCase()];
  return d ? `${d} ${st}` : `D. ${st}`;
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
  const t = String(text || '').replace(/\s+/g, ' ');
  // Section start: a "Related Matters" heading OR the §42.8(b)(2) citation itself
  // (some petitions have no heading — "Pursuant to 37 C.F.R. §42.8(b)(2),
  // Petitioner identifies the following related matter…").
  const heads = [...t.matchAll(/related\s+matters?|related\s+district[- ]court|other\s+proceedings|42\.8\s*\(\s*b\s*\)\s*\(\s*2\s*\)/gi)];
  // Section end: the next mandatory-notices subsection / heading.
  const endRe = /\b(lead\s+and\s+back|lead\s+counsel|back-?up\s+counsel|counsel\s+and\s+service|service\s+information|grounds?\s+for\s+standing|certification\s+of\s+grounds|standing\s+under|statement\s+of\s+precise|precise\s+relief|fee\s+payment|payment\s+of\s+fees|power\s+of\s+attorney|mandatory\s+notice|following\s+counsel)\b/i;
  const subRe = /42\.8\s*\(\s*b\s*\)\s*\(\s*[3-9]\s*\)/i;
  for (const h of heads) {
    const ahead = t.slice(h.index, h.index + 140);
    if (/\.\s?\.\s?\.\s?\./.test(ahead)) continue; // TOC dot-leaders
    const rest = t.slice(h.index + 8);
    const ends = [rest.match(endRe), rest.match(subRe)].filter(Boolean).map((m) => m.index);
    const end = ends.length ? Math.min(Math.min(...ends), 3000) : 3000;
    return { section: t.slice(h.index, h.index + 8 + end), found: true };
  }
  return { section: t.slice(0, 22000), found: false };
}

// What to STORE as petition front-matter (so litigation can be re-parsed without
// re-downloading): a window around the Related Matters section located in the
// FULL petition — the section can sit well past the front (some petitions run the
// technical argument first). Prefers the occurrence actually followed by a case
// (a "v." with a court or civil-action number). Falls back to a front prefix.
export function petitionFrontmatter(fullText) {
  const t = String(fullText || '').replace(/\s+/g, ' ');
  const re = /related\s+matters?|related\s+district[- ]court|other\s+proceedings|42\.8\s*\(\s*b\s*\)\s*\(\s*2\s*\)/gi;
  const cands = [];
  let m;
  while ((m = re.exec(t))) {
    if (/\.\s?\.\s?\.\s?\./.test(t.slice(m.index, m.index + 140))) continue; // skip TOC
    cands.push(m.index);
  }
  const window = (i) => t.slice(Math.max(0, i - 200), i + 9000);
  for (const i of cands) {
    const win = t.slice(i, i + 2600);
    if (/\bv\.?\s/i.test(win) && (/\d{1,2}[:-]\d{2}-cv-?\d{2,6}/.test(win) || /district of|[NSEWMC]\.?\s?D\.?\s?[A-Z]/i.test(win))) return window(i);
  }
  return cands.length ? window(cands[0]) : t.slice(0, 25000);
}

// All district-court jurisdictions named in a chunk of text, as canonical
// shorthands, with the character index of each hit (for petitioner proximity).
function courtHits(chunk) {
  const hits = [];
  let m;
  // A) Parenthetical shorthand/code — "(D. Del.)", "(E.D. Tex.)", "(S.D.N.Y.)", "(DDE)".
  const paren = /\(([^)]{2,28})\)/g;
  while ((m = paren.exec(chunk))) { const c = normCourt(m[1]); if (c) hits.push({ court: c, at: m.index }); }
  // B) Long-form: "(Northern) District of Delaware".
  const long = /\b(Northern|Southern|Eastern|Western|Central|Middle)?\s*District\s+of\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/g;
  while ((m = long.exec(chunk))) { const c = longToShorthand(m[1], m[2]); if (c) hits.push({ court: c, at: m.index }); }
  // C) Bare court codes as standalone tokens — "… 1-15-cv-00271 EDTX" / "DED".
  // Built from every COURT_MAP key so table-style codes are caught reliably.
  const ecf = new RegExp('\\b(' + Object.keys(COURT_MAP).join('|') + ')\\b', 'g');
  while ((m = ecf.exec(chunk))) { const c = normCourt(m[1]); if (c) hits.push({ court: c, at: m.index }); }
  // D) Direction-prefixed reporter shorthand in prose (non-parenthetical) — "in the E.D. Tex.".
  const rep = /\b([NSEWMC]\.?\s?D\.?\s?[A-Z][A-Za-z]{1,4}\.?)/g;
  while ((m = rep.exec(chunk))) { const c = normCourt(m[1]); if (c) hits.push({ court: c, at: m.index }); }
  // E) "Dist. Del." / "Eastern Dist. of Tex." — "Dist." + a Bluebook state abbrev
  //    (some petitions write the parenthetical this way instead of "D. Del.").
  const abbrevAlt = [...new Set(Object.values(STATE))].map((a) => a.replace(/\./g, '\\.')).join('|');
  const dist = new RegExp('\\b(Northern|Southern|Eastern|Western|Central|Middle)?\\s*Dist\\.?\\s+(?:of\\s+)?(' + abbrevAlt + ')(?![A-Za-z])', 'gi');
  while ((m = dist.exec(chunk))) {
    const st = ABBREV_CANON[m[2].toLowerCase()];
    if (!st) continue;
    if (st === 'D.C.') { hits.push({ court: 'D.D.C.', at: m.index }); continue; }
    const d = DIR[String(m[1] || '').toLowerCase()] || 'D.';
    hits.push({ court: `${d} ${st}`, at: m.index });
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
  const { section, found } = sliceRelatedMatters(raw);
  const petTok = petitionerToken(petitionerName);
  const poTok = petitionerToken(poName);
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
      if (!cap || !cap.toLowerCase().includes(poTok)) continue;
      ctx = cap.toLowerCase();
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
