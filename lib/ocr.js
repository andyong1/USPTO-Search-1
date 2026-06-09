// OCR pipeline for scanned petition-decision PDFs using AWS Textract (async), with
// the result stored as a searchable PDF in Vercel Blob. Two phases, because
// Textract is asynchronous and Vercel functions are capped at ~60s:
//   1. start:   download the scanned decision -> put in S3 -> StartDocumentTextDetection
//   2. collect: GetDocumentTextDetection -> assemble text -> 325(d) check ->
//               build a searchable PDF (invisible OCR text layer over the original
//               pages) -> upload to Blob.
//
// All external calls are guarded; if OCR isn't configured the steps no-op.

import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { TextractClient, StartDocumentTextDetectionCommand, GetDocumentTextDetectionCommand } from '@aws-sdk/client-textract';
import { put } from '@vercel/blob';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { fetchDocumentBytes } from './uspto.js';
import { detect325d } from './reexamOutcome.js';

const REGION = process.env.AWS_REGION;
const BUCKET = process.env.TEXTRACT_S3_BUCKET;

export function ocrConfigured() {
  return !!(REGION && BUCKET && process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY && process.env.BLOB_READ_WRITE_TOKEN);
}

const s3key = (appNum, docId) => `reexam-ocr/${String(appNum).replace(/[^\w.-]/g, '_')}-${String(docId).replace(/[^\w.-]/g, '_')}.pdf`;

// Phase 1: upload the decision PDF to S3 and kick off a Textract job. Returns JobId.
export async function startDecisionOcr(appNum, docId) {
  const { buffer } = await fetchDocumentBytes(appNum, docId, 'PDF');
  const Key = s3key(appNum, docId);
  const s3 = new S3Client({ region: REGION });
  await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key, Body: buffer, ContentType: 'application/pdf' }));
  const tx = new TextractClient({ region: REGION });
  const out = await tx.send(new StartDocumentTextDetectionCommand({
    DocumentLocation: { S3Object: { Bucket: BUCKET, Name: Key } },
  }));
  return out.JobId;
}

// Phase 2: collect a finished Textract job. Returns one of:
//   { pending: true } | { failed: true } | { is325d, blobUrl }
export async function collectDecisionOcr(appNum, docId, jobId) {
  const tx = new TextractClient({ region: REGION });
  const blocks = [];
  let nextToken;
  do {
    const r = await tx.send(new GetDocumentTextDetectionCommand({ JobId: jobId, NextToken: nextToken }));
    if (r.JobStatus === 'IN_PROGRESS') return { pending: true };
    if (r.JobStatus === 'FAILED') return { failed: true };
    (r.Blocks || []).forEach((b) => blocks.push(b));
    nextToken = r.NextToken;
  } while (nextToken);

  const text = blocks.filter((b) => b.BlockType === 'LINE').map((b) => b.Text || '').join('\n');
  const is325d = detect325d(text);

  let blobUrl = null;
  try {
    const { buffer } = await fetchDocumentBytes(appNum, docId, 'PDF');
    const pdfBytes = await buildSearchablePdf(buffer, blocks);
    const { url } = await put(`reexam-ocr/${String(appNum).replace(/[^\w.-]/g, '_')}-${String(docId).replace(/[^\w.-]/g, '_')}-searchable.pdf`, pdfBytes, {
      access: 'public', contentType: 'application/pdf', addRandomSuffix: false, allowOverwrite: true, cacheControlMaxAge: 31536000,
    });
    blobUrl = url;
  } catch { /* keep the 325(d) flag even if PDF build/upload fails */ }

  return { is325d, blobUrl };
}

// Overlay an invisible OCR text layer onto the original (scanned) pages so the PDF
// becomes selectable/searchable. Uses Textract WORD geometry (normalized 0–1).
async function buildSearchablePdf(originalBuffer, blocks) {
  const pdf = await PDFDocument.load(originalBuffer, { ignoreEncryption: true });
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const pages = pdf.getPages();
  for (const b of blocks) {
    if (b.BlockType !== 'WORD' || !b.Geometry || !b.Geometry.BoundingBox) continue;
    const page = pages[(b.Page || 1) - 1];
    if (!page) continue;
    const { width, height } = page.getSize();
    const bb = b.Geometry.BoundingBox;
    const size = Math.max(1, bb.Height * height * 0.85);
    const x = bb.Left * width;
    const y = height - (bb.Top + bb.Height) * height;
    const txt = (b.Text || '').replace(/[^\x20-\x7E]/g, ' '); // Helvetica = WinAnsi only
    if (!txt.trim()) continue;
    try { page.drawText(txt, { x, y, size, font, opacity: 0 }); } catch { /* skip unencodable */ }
  }
  return pdf.save();
}
