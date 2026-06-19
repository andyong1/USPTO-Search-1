// Parse the claim disposition (confirmed / cancelled / amended / new) from a
// reexamination CERTIFICATE (RXCERT) by reading the PDF text, falling back to OCR
// for scanned images (most certificates are scanned). Only the formal certificate
// is parsed — not the NIRC. Before parsing we confirm the certificate belongs to
// this proceeding (certCitesProceeding), since another patent's certificate is
// occasionally filed as an exhibit under the RXCERT code. Returns { outcome,
// method, textLen, text, belongs }; belongs is true/false/null (see that helper).
import { fetchDocumentBytes } from './uspto.js';
import { extractPdfText, parseReexamOutcome, certCitesProceeding } from './reexamOutcome.js';
import { ocrTextConfigured, ocrTextOfBuffer } from './ocr.js';

export async function detectCertificateOutcome(appNum, certDocId, { allowOcr = true, downloadMs = 20000, ocrChunks = 3 } = {}) {
  if (!certDocId) return { outcome: null, method: 'none', textLen: 0, text: '', belongs: null };
  const { buffer } = await fetchDocumentBytes(appNum, certDocId, 'PDF', downloadMs);
  let text = '';
  try { text = await extractPdfText(buffer); } catch { text = ''; }
  let method = 'text';
  if (!text || text.replace(/\s/g, '').length < 100) {
    if (!allowOcr) return { outcome: null, method: 'pending-ocr', textLen: 0, text: '', belongs: null };
    if (!ocrTextConfigured()) return { outcome: null, method: 'none', textLen: 0, text: '', belongs: null };
    text = await ocrTextOfBuffer(buffer, ocrChunks);
    method = 'ocr';
  }
  const textLen = text ? text.replace(/\s/g, '').length : 0;
  const belongs = certCitesProceeding(text, appNum);
  // A certificate for a different proceeding (belongs === false) yields no outcome.
  const outcome = belongs === false ? null : parseReexamOutcome(text);
  return { outcome, method, textLen, text, belongs };
}
