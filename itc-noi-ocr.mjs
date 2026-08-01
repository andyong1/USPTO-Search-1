// Two-phase helper for OCR'ing scanned pre-2015 NOIs into the parties pipeline —
// for the ~1/3 of old Notices of Investigation that are image-only PDFs, which
// itc-parties-fetch.mjs (pdf-parse) can't read. One-time backfill: re-mirror the
// target NOIs (edis-mirror.mjs --docs <ids>) first, then:
//   node itc-noi-ocr.mjs download   # scanned NOIs (mirrored, no parties, not staged) -> itc-work/ocr-work/pdf/<docId>.pdf
//   cat itc-ocr.py | python - 20 100000     # OCR them -> itc-work/ocr-work/<docId>.txt
//   node itc-noi-ocr.mjs harvest    # -> itc-work/parties-work/<num>.txt (+ manifest), for the extraction agents
// Requires POSTGRES_URL (+ NODE_OPTIONS=--use-system-ca). Reads NOIs from the public R2 mirror; no EDIS token.
import { sql } from '@vercel/postgres';
import { readFile, writeFile, readdir, mkdir, rm } from 'fs/promises';
import { existsSync } from 'fs';

const MODE = process.argv[2];
const PDIR = 'itc-work/ocr-work/pdf';
const ODIR = 'itc-work/ocr-work';
const PARTIES = 'itc-work/parties-work';

// pre-2015, no parties, mirrored NOI, and NOT already staged (born-digital handled by parties-fetch)
async function scannedNois() {
  const { rows } = await sql`
    SELECT DISTINCT ON (d.investigation_number) d.investigation_number AS num, d.id AS doc, d.mirror_url AS url
    FROM itc_document d
    LEFT JOIN itc_parties p ON p.investigation_number = d.investigation_number
    WHERE d.mirror_url LIKE 'http%' AND lower(d.security_level)='public'
      AND (d.document_title ILIKE 'institution of investigation%' OR d.document_title ILIKE 'notice of investigation%' OR d.document_title ILIKE 'notice of institution%')
      AND (p.complainants IS NULL OR p.complainants::text = '[]')
      AND left(d.received_date,4) < '2015'
    ORDER BY d.investigation_number, d.received_date ASC`;
  return rows.filter((r) => !existsSync(`${PARTIES}/${r.num}.txt`));
}

if (MODE === 'download') {
  await rm(PDIR, { recursive: true, force: true });
  await mkdir(PDIR, { recursive: true });
  const rows = await scannedNois();
  const map = {};
  let ok = 0;
  for (const r of rows) {
    try {
      const res = await fetch(r.url);
      if (!res.ok) { console.log('  fetch fail', r.num, res.status); continue; }
      const buf = Buffer.from(await res.arrayBuffer());
      await writeFile(`${PDIR}/${r.doc}.pdf`, buf);
      map[r.doc] = r.num; ok++;
    } catch (e) { console.log('  err', r.num, String(e.message || e)); }
  }
  await writeFile(`${ODIR}/_noimap.json`, JSON.stringify(map));
  console.log(`downloaded ${ok}/${rows.length} scanned NOI PDF(s) -> ${PDIR}; map -> ${ODIR}/_noimap.json`);
  process.exit(0);
}

if (MODE === 'harvest') {
  const map = JSON.parse(await readFile(`${ODIR}/_noimap.json`, 'utf-8'));
  const manifest = JSON.parse(await readFile(`${PARTIES}/manifest.json`, 'utf-8').catch(() => '[]'));
  const have = new Set(manifest.map((m) => m.investigation_number));
  let wrote = 0, blank = 0;
  for (const [doc, num] of Object.entries(map)) {
    const tf = `${ODIR}/${doc}.txt`;
    if (!existsSync(tf)) continue;
    const text = (await readFile(tf, 'utf-8')).trim();
    if (!text || text === '(no text extracted)' || text.length < 400) { blank++; continue; }
    await writeFile(`${PARTIES}/${num}.txt`, `INVESTIGATION: ${num}\nNOI docId: ${doc}\n\n${text}\n`, 'utf-8');
    if (!have.has(num)) { manifest.push({ investigation_number: num, noiDocId: doc, chars: text.length }); have.add(num); }
    wrote++;
  }
  await writeFile(`${PARTIES}/manifest.json`, JSON.stringify(manifest, null, 1), 'utf-8');
  console.log(`harvested ${wrote} OCR'd NOI(s) into ${PARTIES}; ${blank} blank/too-short skipped; manifest now ${manifest.length}`);
  process.exit(0);
}
console.log('usage: node itc-work/_noi_ocr.mjs download|harvest');
process.exit(1);
