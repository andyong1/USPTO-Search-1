// Parse the claim disposition (confirmed / cancelled / amended / new) from a
// reexamination certificate (RXCERT) — or the NIRC if no certificate is on file
// yet — by reading the PDF text, falling back to OCR for scanned images (most
// certificates are scanned). Returns { outcome, method }; outcome is the
// parseReexamOutcome result (or null if nothing recognizable was found).
import { fetchDocumentBytes } from './uspto.js';
import { extractPdfText, parseReexamOutcome } from './reexamOutcome.js';
import { ocrTextConfigured, ocrTextOfBuffer } from './ocr.js';

export async function detectCertificateOutcome(appNum, certDocId, nircDocId, { allowOcr = true, downloadMs = 20000, ocrChunks = 3 } = {}) {
  const docId = certDocId || nircDocId;
  if (!docId) return { outcome: null, method: 'none' };
  const { buffer } = await fetchDocumentBytes(appNum, docId, 'PDF', downloadMs);
  let text = '';
  try { text = await extractPdfText(buffer); } catch { text = ''; }
  if (text && text.replace(/\s/g, '').length >= 100) {
    return { outcome: parseReexamOutcome(text), method: 'text' };
  }
  if (!allowOcr) return { outcome: null, method: 'pending-ocr' };
  if (!ocrTextConfigured()) return { outcome: null, method: 'none' };
  text = await ocrTextOfBuffer(buffer, ocrChunks);
  return { outcome: parseReexamOutcome(text), method: 'ocr' };
}
