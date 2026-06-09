// Detection + parsing of post-grant patent-owner petitions (document code
// PET.OP, "Petition for review by the Office of Petitions") filed after a reexam
// was ordered — e.g. petitions to reconsider the grant / terminate under 325(d).

import { fetchDocuments, fetchDocumentBytes } from './uspto.js';
import { recordPetition, markPetitionScan, setPetitionParsed } from './db.js';
import { extractPdfText, detect325d, petitionScore } from './reexamOutcome.js';

const PET_CODE = 'PET.OP';
const parseISO = (s) => { const m = String(s || '').match(/(\d{4})-?(\d{2})-?(\d{2})/); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : NaN; };

// Find PET.OP documents filed on/after the reexam order date and record them.
// Always marks the app scanned. Returns how many petitions were recorded.
export async function detectPetitionsForApp(appNum, orderDate) {
  const docs = await fetchDocuments(appNum);
  const orderMs = parseISO(orderDate);
  let count = 0;
  for (const d of docs) {
    if ((d.documentCode || '').toUpperCase() !== PET_CODE) continue;
    const t = parseISO(d.officialDate);
    if (!isNaN(orderMs) && !isNaN(t) && t < orderMs) continue; // pre-grant petition — skip
    await recordPetition({
      applicationNumber: appNum,
      documentIdentifier: d.documentIdentifier,
      petitionDate: d.officialDate,
      orderDate,
      pageCount: d.pageCount,
    });
    count++;
  }
  await markPetitionScan(appNum);
  return count;
}

// Download a petition PDF and flag whether it invokes 325(d). Marks parsed=true
// on success (so it isn't re-parsed); leaves it for retry if the download fails.
export async function parseOnePetition(row) {
  let buffer;
  try { ({ buffer } = await fetchDocumentBytes(row.application_number, row.document_identifier, 'PDF')); }
  catch (e) { throw new Error(`download failed: ${e.message || e}`); }
  const text = await extractPdfText(buffer);
  const is325d = text ? detect325d(text) : false;
  const score = text ? petitionScore(text) : null;
  await setPetitionParsed(row.application_number, row.document_identifier, is325d, score);
  return { is325d, score };
}
