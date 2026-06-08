// Archives USPTO documents to Vercel Blob so a copy persists even if the USPTO
// later removes the document from the public record. Requires the Blob store to
// be linked in Vercel (which sets BLOB_READ_WRITE_TOKEN); if it isn't set,
// archiving is skipped gracefully so the rest of the app keeps working.

import { put } from '@vercel/blob';
import { fetchDocumentBytes } from './uspto.js';

export function blobEnabled() {
  return !!process.env.BLOB_READ_WRITE_TOKEN;
}

// Downloads the document from USPTO and stores it at a stable public path.
// Returns the public URL, or null if Blob isn't configured.
export async function archiveDocument(appNum, documentId, format = 'PDF') {
  if (!blobEnabled()) return null;
  const { buffer, contentType, ext } = await fetchDocumentBytes(appNum, documentId, format);
  const safeApp = String(appNum).replace(/[^0-9A-Za-z]/g, '-');
  const safeId = String(documentId).replace(/[^0-9A-Za-z._-]/g, '');
  const key = `reexam-preorder/${safeApp}/${safeId}.${ext}`;
  const { url } = await put(key, buffer, {
    access: 'public',
    contentType: contentType || 'application/pdf',
    addRandomSuffix: false,
    allowOverwrite: true,
    cacheControlMaxAge: 31536000,
  });
  return url;
}
