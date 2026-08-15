// Shared display formatter for party/examiner names. USPTO feeds many names in
// ALL CAPS (examiners, some assignees) while others arrive title-cased; this
// normalizes the display to Title Case for consistency across every table,
// dropdown, and export. The stored DB value is untouched — this is display only.
//
// Rules:
//  - Only re-case strings that are ALL CAPS (no lowercase). Already mixed/title
//    -case names (e.g. "Sight Sciences, Inc.", "eBay") are left exactly as-is.
//  - Preserve acronyms & legal suffixes (BASF, IBM, LLC, USA, AG, GmbH, roman
//    numerals …) in uppercase.
//  - Lowercase small connector words (of, the, and …) except as the first word.
(function (root) {
  var SMALL = new Set(['of', 'the', 'and', 'for', 'a', 'an', 'to', 'in', 'on', 'at', 'by', 'or', 'as', 'de', 'la', 'le', 'van', 'von', 'del']);
  var KEEP = new Set([
    'LLC', 'LLP', 'LP', 'PLLC', 'PC', 'PLC', 'NA', 'SA', 'AG', 'SE', 'NV', 'BV', 'GMBH', 'KG', 'AB', 'OY', 'AS', 'SPA', 'SRL', 'CO', // note: CO kept upper only if it stands alone; handled below
    'USA', 'US', 'UK', 'EU', 'UAB', 'PTE',
    'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII',
    'BASF', 'IBM', 'LG', 'HP', 'GE', 'BMW', 'KLA', 'NXP', 'AMD', 'TSMC', 'SAP', 'ABB', 'NEC', 'ZTE', '3M', 'ASML', 'SK', 'TCL', 'BOE', 'ARM',
    'DISH', 'KDDI', 'NTT', 'BYD', 'MSI', 'HTC', 'GSK', 'UPS', 'FCA', 'BAE', 'AMD', 'AU', 'JSR', 'DJI', 'ASE', 'UMC', 'IPG',
    // Law-firm entity forms and the acronyms the reexam/ITC corpora actually
    // contain. Added when the firm scorecard was built: it had grown its own
    // private copy of this function rather than loading this file, so these
    // only ever applied to that one page.
    'PA', 'ULC', 'SAS', 'KK', 'APS',
    'IP', 'PTAB', 'IPR', 'TC', 'DC', 'SV', 'CN', 'NY', 'BDX',
    'DLA', 'KED', 'MRG', 'EML', 'MCP', 'VDPP', 'DIVX', 'LCD', 'FMC', 'GME', 'KPN', 'HD', 'IQ', 'MVW', 'OS',
    '3D', 'H2',
  ]);
  // "CO" is ambiguous ("Co." vs a country/acronym); treat the "CO." suffix as "Co."
  KEEP.delete('CO');
  // Names whose correct form is neither all-upper nor plain title case, so
  // neither KEEP (which would leave "GMBH") nor the title-caser ("Gmbh") is right.
  var MIXED = new Map([['GMBH', 'GmbH']]);

  function titleCaseName(s) {
    if (s == null) return s;
    s = String(s);
    if (!s || /[a-z]/.test(s)) return s; // already has lowercase → leave as-is
    var out = s.split(/(\s+)/); // keep the whitespace tokens
    var wordIdx = 0;
    return out.map(function (tok) {
      if (tok === '' || /^\s+$/.test(tok)) return tok;
      wordIdx++;
      var bareUpper = tok.replace(/[^A-Za-z0-9&]/g, '').toUpperCase();
      if (MIXED.has(bareUpper)) return tok.replace(/[A-Za-z]+/, MIXED.get(bareUpper));
      if (KEEP.has(bareUpper)) return tok; // acronym / suffix → keep uppercase verbatim
      var bareLower = tok.replace(/[^A-Za-z]/g, '').toLowerCase();
      if (wordIdx > 1 && bareLower.length > 1 && SMALL.has(bareLower)) return tok.toLowerCase(); // length>1 so a lone "A" middle initial stays uppercase
      // Title-case each alphanumeric run (handles hyphens, slashes, periods, apostrophes).
      var cased = tok.toLowerCase().replace(/[a-z0-9]+/g, function (r) { return r.charAt(0).toUpperCase() + r.slice(1); });
      // A Scottish/Irish prefix carries its own inner capital, which the run-based
      // caser above flattens: MCANDREWS would read "Mcandrews". Only "Mc" is
      // handled — "Mac" is not, because MACHADO would become "MacHado".
      return cased.replace(/\bMc([a-z])/g, function (m, c) { return 'Mc' + c.toUpperCase(); });
    }).join('');
  }

  root.titleCaseName = titleCaseName;
  if (typeof module !== 'undefined' && module.exports) module.exports = { titleCaseName };
})(typeof window !== 'undefined' ? window : globalThis);
