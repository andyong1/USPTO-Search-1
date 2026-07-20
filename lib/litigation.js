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
  const heads = [...t.matchAll(/related\s+matters|related\s+district[- ]court|other\s+proceedings/gi)];
  for (const h of heads) {
    const ahead = t.slice(h.index, h.index + 140);
    if (/\.\s?\.\s?\.\s?\./.test(ahead)) continue; // TOC dot-leaders
    const rest = t.slice(h.index + 8);
    const endRe = /\b(lead\s+and\s+back|lead\s+counsel|back-?up\s+counsel|counsel\s+and\s+service|service\s+information|grounds?\s+for\s+standing|certification\s+of\s+grounds|standing\s+under|statement\s+of\s+precise|precise\s+relief|fee\s+payment|payment\s+of\s+fees|power\s+of\s+attorney|mandatory\s+notice)\b/i;
    const em = rest.match(endRe);
    const end = em ? Math.min(em.index, 3000) : 3000;
    return { section: t.slice(h.index, h.index + 8 + end), found: true };
  }
  return { section: t.slice(0, 22000), found: false };
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
  // C) Bare CM/ECF codes as standalone tokens — "… 1-15-cv-00271  DED".
  const ecf = /\b(DED|DDE|TXED|TXWD|TXND|TXSD|CAND|CACD|CASD|CAED|NYSD|NYED|NJD|ILND|VAED|FLSD|FLMD|GAND|WAWD|MIED|NCWD|NCED)\b/g;
  while ((m = ecf.exec(chunk))) { const c = normCourt(m[1]); if (c) hits.push({ court: c, at: m.index }); }
  // D) Direction-prefixed reporter shorthand in prose (non-parenthetical) — "in the E.D. Tex.".
  const rep = /\b([NSEWMC]\.?\s?D\.?\s?[A-Z][A-Za-z]{1,4}\.?)/g;
  while ((m = rep.exec(chunk))) { const c = normCourt(m[1]); if (c) hits.push({ court: c, at: m.index }); }
  return hits;
}

export function extractRelatedLitigation(text, petitionerName) {
  const raw = String(text || '').replace(/\s+/g, ' ');
  const { section, found } = sliceRelatedMatters(raw);
  const petTok = petitionerToken(petitionerName);
  const petSet = new Set(), otherSet = new Set();

  for (const { court, at } of courtHits(section)) {
    // In the isolated section, any named court is a related litigation. Without a
    // clean heading (fallback), require a case caption / number nearby to avoid
    // sweeping up stray case citations.
    if (!found) {
      const around = section.slice(Math.max(0, at - 220), at + 220);
      if (!/\bv\.?\s/i.test(around) && !/\b\d{1,2}[:-]\d{2}-cv-\d{2,6}/i.test(around)) continue;
    }
    const near = section.slice(Math.max(0, at - 300), at + 300).toLowerCase();
    (petTok && near.includes(petTok) ? petSet : otherSet).add(court);
  }
  for (const c of petSet) otherSet.delete(c);
  return { petitioner: [...petSet].sort(), other: [...otherSet].sort() };
}
