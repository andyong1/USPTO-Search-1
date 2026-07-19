// READ-ONLY probe: can the USPTO ODP return ALL ex parte reexaminations for a
// given patent, with no date bound? Two strategies are tried per patent:
//   A) search applications by patentNumber, flag any 90/ or 96/ control numbers
//   B) find the patent's original application, read its child-continuity bag for
//      "REX" (re-examination) children — the reverse of how we resolve a reexam's
//      underlying patent today.
//
// Prints only public-docket data (control numbers, dates, codes). Never prints
// the API key. Run locally:
//     NODE_OPTIONS=--use-system-ca USPTO_API_KEY=... node probe-reexams.mjs 8408778 [morePatents...]
// Pick a patent you KNOW had an older (pre-2024) reexam to test historical reach.

import { searchApplications, fetchContinuity } from './lib/uspto.js';

const patents = process.argv.slice(2).filter(Boolean);
if (!patents.length) { console.error('Usage: node probe-reexams.mjs <patentNumber> [more...]'); process.exit(1); }

const digits = (s) => String(s || '').replace(/[^0-9]/g, '');
const isReexam = (n) => /^9[056]/.test(digits(n)); // 90/ EPR, 95/ inter partes reexam, 96/ supp-exam

async function probe(patent) {
  const pn = digits(patent);
  console.log(`\n================  PATENT ${patent}  ================`);

  // ── Strategy A: search applications by patent number ──
  let originalApp = null;
  try {
    const data = await searchApplications({
      q: `applicationMetaData.patentNumber:${pn}`,
      fields: ['applicationNumberText', 'applicationMetaData.applicationTypeLabelName',
        'applicationMetaData.filingDate', 'applicationMetaData.patentNumber'],
      pagination: { offset: 0, limit: 50 },
    }, 15000, { retry404: 1 });
    const hits = data.patentFileWrapperDataBag || [];
    console.log(`[A] patentNumber search -> ${data.count ?? hits.length} record(s):`);
    for (const h of hits) {
      const num = h.applicationNumberText || (h.applicationMetaData && h.applicationMetaData.applicationNumberText);
      const md = h.applicationMetaData || {};
      const tag = isReexam(num) ? '  <== REEXAM' : '';
      if (!isReexam(num) && !originalApp) originalApp = num; // first non-reexam = likely the patent's app
      console.log(`     ${num}  ${md.applicationTypeLabelName || ''}  filed ${md.filingDate || '?'}${tag}`);
    }
  } catch (e) { console.log(`[A] error: ${String(e.message || e)}`); }

  // ── Strategy B: original application's child continuity (REX children) ──
  if (!originalApp) { console.log('[B] skipped — no original application found in [A]'); return; }
  try {
    const cont = await fetchContinuity(originalApp);
    const kids = (cont && cont.childContinuityBag) || [];
    const rex = kids.filter((k) => /^REX$/i.test(k.claimParentageTypeCode || '') || /re-?exam/i.test(k.claimParentageTypeCodeDescriptionText || ''));
    console.log(`[B] child continuity of ${originalApp} -> ${kids.length} child link(s), ${rex.length} re-examination:`);
    for (const k of rex) {
      console.log(`     ${k.childApplicationNumberText || '?'}  ${k.claimParentageTypeCode || ''}  ${k.claimParentageTypeCodeDescriptionText || ''}  filed ${k.childFilingDate || k.filingDate || '?'}`);
    }
    if (!rex.length && kids.length) {
      console.log('     (no REX children — sample of child codes seen:)');
      for (const k of kids.slice(0, 8)) console.log(`       ${k.childApplicationNumberText || '?'}  ${k.claimParentageTypeCode || ''}  ${k.claimParentageTypeCodeDescriptionText || ''}`);
    }
  } catch (e) { console.log(`[B] error: ${String(e.message || e)}`); }
}

for (const p of patents) { await probe(p); }
console.log('\nDone.');
