// Shared display helpers. Every page had grown its own copy of these, which is
// how the same one-line function came to exist in thirteen places with three
// different behaviours — the reason this file exists.
//
// Loaded as a plain script (like theme.js and names.js), so the helpers are
// globals available to each page's inline script. No build step.
(function (root) {
  // ── Escaping ────────────────────────────────────────────────────────────
  // The apostrophe is escaped too. Most page copies omitted it; including it is
  // a superset and is what makes esc() safe inside a single-quoted inline
  // handler, e.g. onclick="f('${esc(v)}')".
  var ENT = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ENT[c]; });
  }

  // EDIS delivers text that is ALREADY html-escaped ("Alston &amp; Bird LLP").
  // Escaping that again renders "&amp;amp;", so the ITC pages first decode the
  // entities they know about and then re-escape once. Kept as a separate export
  // rather than folded into esc(): decoding is wrong for any source that sends
  // a literal "&amp;" meaning those six characters.
  function escEntities(s) {
    return String(s == null ? '' : s)
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#0*39;|&apos;/g, "'")
      .replace(/[&<>"']/g, function (c) { return ENT[c]; });
  }

  // ── Dates ───────────────────────────────────────────────────────────────
  // Pulls YYYY-MM-DD out of whatever the API returned (bare date, ISO stamp, or
  // an offset timestamp) without constructing a Date, so a UTC-midnight value
  // never renders as the previous day in a western timezone.
  //
  // `empty` is a parameter because the page copies disagreed: most showed an em
  // dash, file-history showed nothing. Defaulting to the em dash keeps the
  // majority behaviour and lets the odd one out ask for ''.
  function fmtDate(raw, empty) {
    if (empty === undefined) empty = '—';
    if (!raw) return empty;
    var m = String(raw).match(/(\d{4})-?(\d{2})-?(\d{2})/);
    return m ? m[1] + '-' + m[2] + '-' + m[3] : String(raw);
  }

  // Full timestamp in Pacific time — the timezone every schedule on this site
  // is expressed in, so a reader never has to convert.
  function fmtTs(ts) {
    if (!ts) return '—';
    var d = new Date(ts);
    return isNaN(d) ? String(ts) : d.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }) + ' PT';
  }

  // ── Misc ────────────────────────────────────────────────────────────────
  // Median of a numeric array; null when empty. Even-length rounds the mean of
  // the middle pair, matching what the five page copies did.
  function median(a) {
    if (!a || !a.length) return null;
    var s = a.slice().sort(function (x, y) { return x - y; });
    var m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
  }

  // Escape for use inside a single-quoted string in an inline handler.
  function jsq(s) {
    return String(s == null ? '' : s)
      .replace(/\\/g, '\\\\').replace(/'/g, "\\'")
      .replace(/"/g, '&quot;').replace(/</g, '&lt;');
  }

  root.esc = esc;
  root.escEntities = escEntities;
  root.fmtDate = fmtDate;
  root.fmtTs = fmtTs;
  root.median = median;
  root.jsq = jsq;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { esc: esc, escEntities: escEntities, fmtDate: fmtDate, fmtTs: fmtTs, median: median, jsq: jsq };
  }
})(typeof window !== 'undefined' ? window : globalThis);
