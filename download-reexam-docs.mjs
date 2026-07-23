// Download every reexamination DETERMINATION and OFFICE ACTION PDF listed on the
// site into ./downloads/ (determinations/ and office-actions/ subfolders).
//
// Requires Node 18+ (uses global fetch). Run from this folder:
//     node download-reexam-docs.mjs
// Options (env vars):
//     SITE_BASE   site origin (default https://andy-ong.com)
//     OUT_DIR     output folder (default ./downloads)
//     CONCURRENCY parallel downloads (default 4)
// It's safe to re-run: files already downloaded are skipped, so you can resume.

import { mkdir, writeFile, access } from 'node:fs/promises';
import path from 'node:path';

const BASE = (process.env.SITE_BASE || 'https://andy-ong.com').replace(/\/$/, '');
const OUT = process.env.OUT_DIR || './downloads';
const CONCURRENCY = Number(process.env.CONCURRENCY) || 4;

const sanitize = (s) => String(s || '').replace(/[^0-9A-Za-z._-]/g, '_');
const ymd = (s) => { const m = String(s || '').match(/(\d{4})-?(\d{2})-?(\d{2})/); return m ? `${m[1]}-${m[2]}-${m[3]}` : 'nodate'; };
const exists = async (p) => { try { await access(p); return true; } catch { return false; } };

async function getJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} → HTTP ${r.status}`);
  return r.json();
}

async function downloadOne(job) {
  const { appNum, docId, dir, name } = job;
  if (!appNum || !docId) return { skipped: true };
  const file = path.join(OUT, dir, `${name}.pdf`);
  if (await exists(file)) return { skipped: true, file };
  const url = `${BASE}/api/document?appNum=${encodeURIComponent(appNum)}&documentId=${encodeURIComponent(docId)}&format=PDF&disposition=attachment`;
  let res;
  try { res = await fetch(url); } catch (e) { return { error: String(e.message || e), job }; }
  if (!res.ok) return { error: `HTTP ${res.status}`, job };
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.slice(0, 5).toString('latin1') !== '%PDF-') return { error: 'not a PDF (likely an error page)', job };
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, buf);
  return { ok: true, file };
}

async function runPool(jobs, n) {
  const results = [];
  let i = 0;
  const worker = async () => {
    while (i < jobs.length) {
      const r = await downloadOne(jobs[i++]);
      results.push(r);
      process.stdout.write(r.ok ? '.' : (r.skipped ? 's' : 'x'));
    }
  };
  await Promise.all(Array.from({ length: n }, worker));
  return results;
}

console.log(`Fetching document lists from ${BASE} …`);
const dets = (await getJson(`${BASE}/api/reexam`)).determinations || [];
const acts = (await getJson(`${BASE}/api/reexam?actions=1`)).actions || [];

const jobs = [];
for (const d of dets) {
  if (!d.document_identifier) continue;
  jobs.push({
    appNum: d.application_number, docId: d.document_identifier, dir: 'determinations',
    name: `${sanitize(d.application_number)}_${sanitize(d.determination_type || 'determination')}_${ymd(d.official_date)}_${sanitize(d.document_identifier)}`,
  });
}
for (const a of acts) {
  if (a.nonf_doc_id) jobs.push({ appNum: a.application_number, docId: a.nonf_doc_id, dir: 'office-actions', name: `${sanitize(a.application_number)}_nonfinal_${ymd(a.nonf_date)}_${sanitize(a.nonf_doc_id)}` });
  if (a.finl_doc_id) jobs.push({ appNum: a.application_number, docId: a.finl_doc_id, dir: 'office-actions', name: `${sanitize(a.application_number)}_final_${ymd(a.finl_date)}_${sanitize(a.finl_doc_id)}` });
}

console.log(`${dets.length} determinations, ${acts.length} office-action rows → ${jobs.length} PDFs into ${path.resolve(OUT)}`);
console.log('Legend: . downloaded   s skipped (already present)   x failed\n');
const results = await runPool(jobs, CONCURRENCY);

const ok = results.filter((r) => r.ok).length;
const skipped = results.filter((r) => r.skipped).length;
const errs = results.filter((r) => r.error);
console.log(`\n\nDone. ${ok} downloaded, ${skipped} already present, ${errs.length} failed.`);
if (errs.length) {
  console.log('Failures (first 25):');
  errs.slice(0, 25).forEach((e) => console.log(`  ${e.job.appNum}/${e.job.docId}: ${e.error}`));
  console.log('Re-run the script to retry failures (successful files are skipped).');
}
