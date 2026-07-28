// USITC Section 337 tracker — wipe the Blob PDF mirror.
//
// The free Vercel Blob tier is 1 GB; a full key-doc mirror is tens of GB, which
// gets the whole store suspended (taking the /itc data blobs down with it). This
// deletes every mirrored PDF (itc/doc/*), clears mirror_url in Neon, and
// republishes the affected investigations' detail blobs so they fall back to the
// "On EDIS ↗" link (no dead download links). The catalog/detail JSON blobs
// (itc-data.json, itc/inv/*) are left untouched.
//
// Requires: POSTGRES_URL, BLOB_READ_WRITE_TOKEN (+ NODE_EXTRA_CA_CERTS on an
// SSL-inspected network). Load grounds-secrets.env first.
//
//   node itc-mirror-clear.mjs            # delete + clear + republish
//   node itc-mirror-clear.mjs --dry-run  # just report what would be deleted

import { list, del } from '@vercel/blob';
import { mirroredInvestigationNumbers, clearAllMirrorUrls } from './lib/itc-db.js';
import { loadCatalogMaps, publishInvestigationDocs } from './lib/itc-publish.js';

for (const v of ['POSTGRES_URL', 'BLOB_READ_WRITE_TOKEN']) {
  if (!process.env[v]) { console.error(`${v} is not set. Load grounds-secrets.env first.`); process.exit(1); }
}
const DRY = process.argv.includes('--dry-run');

async function retry(fn, tries = 4) {
  for (let i = 1; ; i++) {
    try { return await fn(); }
    catch (e) {
      const msg = String((e && e.message) || e);
      if (i >= tries || !/fetch failed|ECONN|ETIMEDOUT|EPIPE|socket|network|terminated|5\d\d/i.test(msg)) throw e;
      await new Promise((r) => setTimeout(r, 800 * i));
    }
  }
}

// Record the affected investigations BEFORE clearing (the query keys off mirror_url).
const affected = await mirroredInvestigationNumbers();
console.log(`${affected.length} investigation(s) currently have mirrored PDFs.`);

// 1) Delete every itc/doc/* blob (paginated; itc/inv/* and itc-data.json untouched).
let cursor, seen = 0, deleted = 0, bytes = 0;
do {
  const page = await retry(() => list({ prefix: 'itc/doc/', cursor, limit: 1000 }));
  seen += page.blobs.length;
  bytes += page.blobs.reduce((s, b) => s + (b.size || 0), 0);
  if (page.blobs.length && !DRY) {
    // Delete in chunks to stay well within del()'s per-call limits.
    for (let i = 0; i < page.blobs.length; i += 100) {
      const chunk = page.blobs.slice(i, i + 100).map((b) => b.url);
      await retry(() => del(chunk));
      deleted += chunk.length;
      process.stdout.write(`\r  deleted ${deleted} blob(s), ${(bytes / 1048576).toFixed(0)} MB…`);
    }
  }
  cursor = page.cursor;
} while (cursor);
process.stdout.write('\n');

if (DRY) {
  console.log(`[dry-run] ${seen} mirrored PDF(s), ${(bytes / 1048576).toFixed(0)} MB would be deleted; ${affected.length} detail blob(s) would be republished.`);
  process.exit(0);
}
console.log(`Deleted ${deleted} PDF(s) (${(bytes / 1048576).toFixed(0)} MB freed).`);

// 2) Clear mirror_url in Neon.
const cleared = await retry(() => clearAllMirrorUrls());
console.log(`Cleared mirror_url on ${cleared} document(s).`);

// 3) Republish affected detail blobs so they drop the (now-dead) mirror links.
let metaByNumber = new Map();
try { ({ metaByNumber } = await loadCatalogMaps('itc-work')); } catch { /* header meta optional */ }
let rp = 0;
for (const number of affected) {
  try { await retry(() => publishInvestigationDocs(number, metaByNumber.get(number))); rp++; }
  catch (e) { console.error(`  republish ${number} failed: ${(e && e.message) || e}`); }
  if (rp % 25 === 0 || rp === affected.length) process.stdout.write(`\r  republished ${rp}/${affected.length} detail blob(s)…`);
}
process.stdout.write('\n');
console.log(`Done. Freed ${(bytes / 1048576).toFixed(0)} MB; ${rp} detail blob(s) now link to EDIS instead.`);
