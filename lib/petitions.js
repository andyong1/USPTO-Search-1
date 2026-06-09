// Detection of post-order patent-owner petitions and the surrounding cluster:
//   - Patent Owner Petition: document code PET.OP filed after the reexam was
//     ordered (if multiple PET.OP, the fewest-page one is the petition itself,
//     the rest being exhibits).
//   - Requester Opposition: RXPET. ("Receipt of Petition in a Reexam") filed by
//     the third-party requester after the petition.
//   - Petition Decision: an Office of Petitions decision (RXPTGR granted /
//     RXPTDI dismissed, or a petition decision document) after the petition.

import { fetchDocuments } from './uspto.js';
import { recordPostPetition, markPetitionScan } from './db.js';

const PET_CODE = 'PET.OP';
const OPP_CODES = new Set(['RXPET.', 'RXOPPPET']);
const DECISION = { RXPTGR: 'granted', RXPTDI: 'dismissed' };
const parseISO = (s) => { const m = String(s || '').match(/(\d{4})-?(\d{2})-?(\d{2})/); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : NaN; };
const pages = (d) => (d.pageCount == null ? Infinity : d.pageCount);

// Find a proceeding's post-order petition cluster and record it. Always marks the
// app scanned. Returns 1 if a patent-owner petition was found, else 0.
export async function detectPostOrderPetitionForApp(appNum, orderDate) {
  const docs = await fetchDocuments(appNum);
  const orderMs = parseISO(orderDate);

  // Patent-owner petition: PET.OP on/after the order; fewest pages if several.
  let petition = null;
  for (const d of docs) {
    if ((d.documentCode || '').toUpperCase() !== PET_CODE) continue;
    const t = parseISO(d.officialDate);
    if (!isNaN(orderMs) && !isNaN(t) && t < orderMs) continue;
    if (!petition || pages(d) < pages(petition)) petition = d;
  }
  if (!petition) { await markPetitionScan(appNum); return 0; }
  const petMs = parseISO(petition.officialDate);

  // Requester opposition: earliest RXPET./RXOPPPET filed strictly AFTER the
  // petition date (same-day documents are excluded).
  let opposition = null;
  for (const d of docs) {
    if (!OPP_CODES.has((d.documentCode || '').toUpperCase())) continue;
    const t = parseISO(d.officialDate);
    if (isNaN(t) || (!isNaN(petMs) && t <= petMs)) continue;
    if (!opposition || parseISO(d.officialDate) < parseISO(opposition.officialDate)) opposition = d;
  }

  // Petition decision: earliest grant/dismissal (by code or description) after it.
  let decision = null, outcome = null;
  for (const d of docs) {
    const code = (d.documentCode || '').toUpperCase();
    const desc = (d.description || '').toLowerCase();
    let oc = DECISION[code] || null;
    if (!oc && /petition/.test(desc) && /(dismiss|grant|denied|decision)/.test(desc)) {
      oc = /dismiss/.test(desc) ? 'dismissed' : /grant/.test(desc) ? 'granted' : /denied/.test(desc) ? 'denied' : 'decided';
    }
    if (!oc) continue;
    const t = parseISO(d.officialDate);
    if (!isNaN(petMs) && !isNaN(t) && t < petMs) continue;
    if (!decision || parseISO(d.officialDate) < parseISO(decision.officialDate)) { decision = d; outcome = oc; }
  }

  await recordPostPetition(appNum, {
    orderDate,
    petitionDocId: petition.documentIdentifier, petitionDate: petition.officialDate, petitionPages: petition.pageCount,
    oppositionDocId: opposition && opposition.documentIdentifier, oppositionDate: opposition && opposition.officialDate,
    decisionDocId: decision && decision.documentIdentifier, decisionDate: decision && decision.officialDate, decisionOutcome: outcome,
  });
  await markPetitionScan(appNum);
  return 1;
}
