// Extract related district-court litigation from an IPR petition's text — the
// "Related Matters Under 37 C.F.R. § 42.8(b)(2)" disclosures (and the parallel
// complaints petitions list as exhibits). We key on the reliable signal: a court
// parenthetical — "(E.D. Tex.)" or an ECF code "(DDE)" — sitting next to a case
// caption ("X v. Y") or a district-court case number. That works regardless of
// where in the petition it appears (Related Matters prose, exhibit list, standing
// section) and sidesteps the table-of-contents false hits.
//
// These reflect what the PETITION disclosed AT FILING — not verified live
// pendency. Heuristic and precision-biased; all functions are pure + unit-tested.

// Known patent-heavy districts, keyed by the normalized token (uppercase, letters
// only) of BOTH the reporter abbreviation and the CM/ECF court code.
const COURT_MAP = {
  DDEL: 'D. Del.', DDE: 'D. Del.', DED: 'D. Del.',
  EDTEX: 'E.D. Tex.', TXED: 'E.D. Tex.', WDTEX: 'W.D. Tex.', TXWD: 'W.D. Tex.',
  NDTEX: 'N.D. Tex.', TXND: 'N.D. Tex.', SDTEX: 'S.D. Tex.', TXSD: 'S.D. Tex.',
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
  DOR: 'D. Or.', ORD: 'D. Or.', DNEV: 'D. Nev.', NVD: 'D. Nev.',
};

// Map a raw parenthetical token to a canonical district shorthand, or null.
export function normCourt(token) {
  const key = String(token || '').toUpperCase().replace(/[^A-Z]/g, '');
  return COURT_MAP[key] || null;
}

// Distinctive lower-case token for the petitioner (for "is the petitioner a party
// to this case?"). First meaningful word, past a leading article and corporate
// forms. Returns '' if nothing usable.
const CORP = new Set(['the', 'inc', 'llc', 'llp', 'lp', 'co', 'corp', 'corporation',
  'company', 'ltd', 'limited', 'gmbh', 'ag', 'sa', 'plc', 'holdings', 'holding', 'and']);
export function petitionerToken(name) {
  for (const w of String(name || '').split(/[^A-Za-z0-9]+/)) {
    const lw = w.toLowerCase();
    if (lw.length >= 3 && !CORP.has(lw)) return lw;
  }
  return '';
}

// Extract related litigation and split jurisdictions into those where the
// petitioner is a named party vs. everything else on the same patent.
// Returns { petitioner: [shorthands], other: [shorthands] } (sorted, de-duped).
export function extractRelatedLitigation(text, petitionerName) {
  const t = String(text || '').replace(/\s+/g, ' ');
  const petTok = petitionerToken(petitionerName);
  const petSet = new Set(), otherSet = new Set();
  // Every parenthetical; keep those that resolve to a known district AND whose
  // preceding context looks like a case caption / case number (not a stray cite).
  const paren = /\(([^)]{2,28})\)/g;
  let m;
  while ((m = paren.exec(t))) {
    const court = normCourt(m[1]);
    if (!court) continue;
    const ctx = t.slice(Math.max(0, m.index - 220), m.index);
    const isCase = /\bv\.?\s/i.test(ctx) || /\b\d{1,2}[:-]\d{2}-cv-\d{2,6}/i.test(ctx);
    if (!isCase) continue;
    const involvesPetitioner = !!petTok && ctx.toLowerCase().includes(petTok);
    (involvesPetitioner ? petSet : otherSet).add(court);
  }
  // A court where the petitioner is a party shouldn't also appear under "other".
  for (const c of petSet) otherSet.delete(c);
  return { petitioner: [...petSet].sort(), other: [...otherSet].sort() };
}
