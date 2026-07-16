// Shared .xlsx export for the proceedings-table pages, so every table exports the
// same way. Lazy-loads SheetJS from the CDN on first use (pages don't all need to
// carry it). Usage:
//   exportXlsx('file.xlsx', headers, rows, opts)
//     headers  – array of column titles
//     rows     – array of row arrays (aligned to headers)
//     opts.colWidths   – array of column widths (chars)
//     opts.sheetName   – data sheet name (default 'Data')
//     opts.summary     – optional array-of-arrays for a leading "Summary" sheet
//     opts.summaryCols – column widths for the summary sheet
(function () {
  var SRC = 'https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js';
  // Subresource Integrity (SEC-6): sha384 of the pinned 0.20.3 build, so a
  // compromised/altered CDN file is refused. Recompute if SRC ever changes.
  var SRI = 'sha384-EnyY0/GSHQGSxSgMwaIPzSESbqoOLSexfnSMN2AP+39Ckmn92stwABZynq1JyzdT';
  var loading;
  function ensureSheetJs() {
    if (window.XLSX) return Promise.resolve();
    if (loading) return loading;
    loading = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = SRC; s.defer = true;
      s.integrity = SRI; s.crossOrigin = 'anonymous';
      s.onload = resolve;
      s.onerror = function () { reject(new Error('Could not load the spreadsheet library — check your connection and try again.')); };
      document.head.appendChild(s);
    });
    return loading;
  }
  window.exportXlsx = async function (filename, headers, rows, opts) {
    opts = opts || {};
    try { await ensureSheetJs(); } catch (e) { alert(e.message); return; }
    var wb = XLSX.utils.book_new();
    if (opts.summary && opts.summary.length) {
      var sws = XLSX.utils.aoa_to_sheet(opts.summary);
      if (opts.summaryCols) sws['!cols'] = opts.summaryCols.map(function (w) { return { wch: w }; });
      XLSX.utils.book_append_sheet(wb, sws, 'Summary');
    }
    var ws = XLSX.utils.aoa_to_sheet([headers].concat(rows));
    if (opts.colWidths) ws['!cols'] = opts.colWidths.map(function (w) { return { wch: w }; });
    XLSX.utils.book_append_sheet(wb, ws, opts.sheetName || 'Data');
    XLSX.writeFile(wb, filename);
  };
})();
