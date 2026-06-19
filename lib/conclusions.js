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
  const layerLen = text ? text.replace(/\s/g, '').length : 0;
  if (layerLen >= 100) {
    return { outcome: parseReexamOutcome(text), method: 'text', textLen: layerLen, text };
  }
  if (!allowOcr) return { outcome: null, method: 'pending-ocr', textLen: layerLen, text };
  if (!ocrTextConfigured()) return { outcome: null, method: 'none', textLen: layerLen, text };
  text = await ocrTextOfBuffer(buffer, ocrChunks);
  const ocrLen = text ? text.replace(/\s/g, '').length : 0;
  return { outcome: parseReexamOutcome(text), method: 'ocr', textLen: ocrLen, text };
}
