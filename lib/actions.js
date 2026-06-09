// Detect ex parte reexam office actions on the merits and record their dates:
//   - First non-final action  (code RXR.NF; "Reexam - Non-Final Action")
//   - First final action       (code RXR.F;  "Reexam - Final Action")
// Matched by code OR description so it's robust to coding variations.

import { fetchDocuments } from './uspto.js';
import { recordActions } from './db.js';

const parseISO = (s) => { const m = String(s || '').match(/(\d{4})-?(\d{2})-?(\d{2})/); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : NaN; };

function isNonFinal(d) {
  const c = (d.documentCode || '').toUpperCase();
  const desc = (d.description || '').toLowerCase();
  if (['RXR.NF', 'NONF', 'CTNF'].includes(c)) return true;
  return /non[\s-]*final/.test(desc) && /(action|rejection)/.test(desc);
}
function isFinal(d) {
  const c = (d.documentCode || '').toUpperCase();
  const desc = (d.description || '').toLowerCase();
  if (/non[\s-]*final/.test(desc)) return false; // never treat non-final as final
  if (['RXR.F', 'RXR.FN', 'FINL', 'CTFR'].includes(c)) return true;
  return /\bfinal\b/.test(desc) && /(action|rejection)/.test(desc);
}

// Find the earliest non-final and final actions on/after the order date; record them.
export async function detectActionsForApp(appNum, orderDate) {
  const docs = await fetchDocuments(appNum);
  const orderMs = parseISO(orderDate);
  const onOrAfter = (d) => { const t = parseISO(d.officialDate); return !isNaN(t) && (isNaN(orderMs) || t >= orderMs); };
  let nonf = null, finl = null, actionCount = 0;
  for (const d of docs) {
    if (!onOrAfter(d)) continue;
    const nf = isNonFinal(d), fn = isFinal(d);
    if (nf || fn) actionCount++;
    if (nf && (!nonf || parseISO(d.officialDate) < parseISO(nonf.officialDate))) nonf = d;
    if (fn && (!finl || parseISO(d.officialDate) < parseISO(finl.officialDate))) finl = d;
  }
  await recordActions(appNum, {
    orderDate,
    nonfDate: nonf && nonf.officialDate, nonfDocId: nonf && nonf.documentIdentifier,
    finlDate: finl && finl.officialDate, finlDocId: finl && finl.documentIdentifier,
    actionCount,
  });
  return { nonf: !!nonf, finl: !!finl };
}
