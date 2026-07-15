// Resolve the technology center of the patent that an ex parte reexamination is
// re-examining. The reexam control-number record itself carries only the office
// handling the reexam (CRU 399x for utility, 29xx for design) — not the
// underlying patent's technology. So we follow two hops:
//   1. reexam continuity -> parent with claimParentageTypeCode "REX" (the
//      "is a Re-examination of" link) -> underlying application number
//   2. that application's group art unit -> TC = first two digits + "00"

import { fetchContinuity, fetchMetaData } from './uspto.js';
import { recordTechCenter } from './db.js';

export async function detectTechCenterForApp(controlNumber) {
  const cont = await fetchContinuity(controlNumber);
  const bag = (cont && cont.parentContinuityBag) || [];
  let parentApp = null, parentPatent = null;
  for (const p of bag) {
    const code = String(p.claimParentageTypeCode || '').toUpperCase();
    const desc = String(p.claimParentageTypeCodeDescriptionText || '').toLowerCase();
    if (code === 'REX' || /re-?examination/.test(desc)) {
      parentApp = p.parentApplicationNumberText || parentApp;
      parentPatent = p.parentPatentNumber || parentPatent;
      if (parentApp) break;
    }
  }

  if (!parentApp) {
    await recordTechCenter(controlNumber, {}); // stamp checked_at; nothing to resolve
    return { found: false };
  }

  const meta = await fetchMetaData(parentApp).catch(() => ({}));
  const au = String(meta.groupArtUnit || '').trim();
  const techCenter = /^\d{2}/.test(au) ? au.slice(0, 2) + '00' : null;
  await recordTechCenter(controlNumber, {
    // Continuity often omits the parent's patent number; fall back to the granted
    // patent number on the underlying application's metadata (already fetched above).
    underlyingApplication: parentApp, underlyingPatent: parentPatent || meta.patentNumber || null,
    groupArtUnit: au || null, techCenter,
  });
  return { found: !!techCenter, techCenter };
}
