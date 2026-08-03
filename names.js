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
  ]);
  // "CO" is ambiguous ("Co." vs a country/acronym); treat the "CO." suffix as "Co."
  KEEP.delete('CO');

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
      if (KEEP.has(bareUpper)) return tok; // acronym / suffix → keep uppercase verbatim
      var bareLower = tok.replace(/[^A-Za-z]/g, '').toLowerCase();
      if (wordIdx > 1 && bareLower.length > 1 && SMALL.has(bareLower)) return tok.toLowerCase(); // length>1 so a lone "A" middle initial stays uppercase
      // Title-case each alphanumeric run (handles hyphens, slashes, periods, apostrophes).
      return tok.toLowerCase().replace(/[a-z0-9]+/g, function (r) { return r.charAt(0).toUpperCase() + r.slice(1); });
    }).join('');
  }

  root.titleCaseName = titleCaseName;
  if (typeof module !== 'undefined' && module.exports) module.exports = { titleCaseName };
})(typeof window !== 'undefined' ? window : globalThis);
