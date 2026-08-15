// Assignment-chain reading: what kind of transfer a recorded document is, and
// which assignee is therefore the current owner.
//
// The regexes here are the SAME ones lib/uspto.js uses server-side to fill the
// Patent Owner column on /reexam. They are duplicated deliberately — that file is
// server ESM and this one has to load as a plain browser script — and a unit test
// asserts the two agree on a shared fixture set, because two pages of this site
// disagreeing about who owns a patent would be worse than the duplication.
(function (root) {
  // An "assignee" on a security interest is a lender or collateral agent, not an
  // owner: "HERCULES CAPITAL, INC., AS AGENT" holds a lien, and reading it as the
  // owner is the classic way an assignment chain is misread.
  var SKIP_CONVEYANCE = /SECURITY|RELEASE|LIEN|COLLATERAL|LICENSE/;
  var OWNER_CONVEYANCE = /ASSIGNMENT OF ASSIGNOR|NUNC PRO TUNC|CORRECTIVE ASSIGNMENT|MERGER|CHANGE OF NAME/;

  /**
   * 'ownership' — moves title, so it can determine the current owner.
   * 'security'  — a lien, release, licence or collateral grant. Recorded against
   *               the patent but does NOT transfer ownership.
   * 'other'     — anything else (declarations, name-only corrections the pattern
   *               does not recognise). Shown, never used to infer ownership.
   */
  function classifyConveyance(text) {
    var t = String(text || '').toUpperCase();
    if (!t) return 'other';
    if (SKIP_CONVEYANCE.test(t)) return 'security';
    if (OWNER_CONVEYANCE.test(t)) return 'ownership';
    return 'other';
  }

  function recordedDate(a) {
    return String((a && (a.assignmentRecordedDate || a.recordedDate)) || '');
  }

  /** Every ownership-transfer record, oldest first. */
  function ownershipChain(bag) {
    if (!Array.isArray(bag)) return [];
    return bag
      .filter(function (a) { return classifyConveyance(a && a.conveyanceText) === 'ownership'; })
      .slice()
      .sort(function (a, b) { return recordedDate(a).localeCompare(recordedDate(b)); });
  }

  /**
   * Current owner: the assignee on the most recently recorded ownership transfer.
   * Empty when the chain holds no ownership transfer at all — an honest "not
   * recorded" rather than falling back to a lienholder.
   */
  function pickAssignmentOwner(bag) {
    var owns = ownershipChain(bag);
    if (!owns.length) return '';
    var latest = owns[owns.length - 1];
    var as = (latest.assigneeBag || [])[0];
    return String((as && (as.assigneeNameText || as.assigneeName)) || '').trim();
  }

  /** Flatten an ODP address object into one line. */
  function addressLine(a) {
    if (!a) return '';
    return [a.addressLineOneText, a.addressLineTwoText, a.cityName,
      a.geographicRegionCode || a.geographicRegionName, a.postalCode,
      a.countryName && a.countryName !== 'UNITED STATES' ? a.countryName : '']
      .map(function (x) { return String(x || '').trim(); })
      .filter(Boolean).join(', ');
  }

  root.classifyConveyance = classifyConveyance;
  root.ownershipChain = ownershipChain;
  root.pickAssignmentOwner = pickAssignmentOwner;
  root.assignmentAddressLine = addressLine;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { classifyConveyance: classifyConveyance, ownershipChain: ownershipChain,
      pickAssignmentOwner: pickAssignmentOwner, assignmentAddressLine: addressLine };
  }
})(typeof window !== 'undefined' ? window : globalThis);
