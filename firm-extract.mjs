// Attribute a law firm to each side of every reexamination, from the determination
// text we already OCR locally (snq-cumulative/text/). No API calls, no new OCR.
// Version-gated on FIRM_V, so re-running after an extractor change re-does the work.
//
//     set -a && . ./grounds-secrets.env && set +a && node firm-extract.mjs [--limit N]

import { readdir, readFile } from 'node:fs/promises';
import { sql } from '@vercel/postgres';
import { setReexamFirms, FIRM_V, ensureSchema } from './lib/db.js';
import { extractFirmBlocks, normalizeFirm, classifyFiler } from './lib/firms.js';

if (!process.env.POSTGRES_URL) { console.error('POSTGRES_URL required — source grounds-secrets.env.'); process.exit(1); }
// Run migrations before the raw SELECT below — otherwise the first run fails with
// "relation reexam_firm does not exist", since nothing else here would trigger them.
await ensureSchema();
const args = process.argv.slice(2);
const li = args.indexOf('--limit');
const LIMIT = li >= 0 ? Number(args[li + 1]) : Infinity;

const DIR = 'snq-cumulative/text';
const files = (await readdir(DIR)).filter((f) => f.endsWith('.txt'));

// One entry per proceeding, keyed on its EARLIEST determination — that is the one
// answering the request, so it is what a requester-side grant rate measures.
const earliest = new Map();
for (const f of files) {
  const m = f.match(/^(\d+)_(order|denial)_(\d{4}-\d{2}-\d{2})_/);
  if (!m) continue;
  const [, app, kind, date] = m;
  const prev = earliest.get(app);
  if (!prev || date < prev.date) earliest.set(app, { app, kind, date, file: f });
}

const already = new Set((await sql`SELECT application_number FROM reexam_firm WHERE firm_v >= ${FIRM_V}`).rows
  .map((r) => r.application_number));
const todo = [...earliest.values()].filter((e) => !already.has(e.app)).slice(0, LIMIT);
console.log(`${earliest.size} proceeding(s) with a determination text; ${already.size} already at v${FIRM_V}; processing ${todo.length}.`);

let done = 0, bothSides = 0, ownerOnly = 0, reqOnly = 0, neither = 0;
for (const e of todo) {
  const text = await readFile(`${DIR}/${e.file}`, 'utf-8');
  const b = extractFirmBlocks(text);
  const own = normalizeFirm(b.ownerRaw || '');
  const req = normalizeFirm(b.requesterRaw || '');
  await setReexamFirms(e.app, {
    determinationDate: e.date,
    determinationKind: e.kind,
    ownerRaw: b.ownerRaw, ownerFirm: own.display || null, ownerKey: own.key || null,
    ownerType: b.ownerRaw ? classifyFiler(b.ownerRaw) : null,
    requesterRaw: b.requesterRaw, requesterFirm: req.display || null, requesterKey: req.key || null,
    requesterType: b.requesterRaw ? classifyFiler(b.requesterRaw) : null,
  });
  done++;
  if (own.key && req.key) bothSides++;
  else if (own.key) ownerOnly++;
  else if (req.key) reqOnly++;
  else neither++;
  if (done % 200 === 0) console.log(`  …${done}/${todo.length}`);
}

console.log(`\nDone. ${done} proceeding(s) attributed.`);
console.log(`  both sides: ${bothSides} | owner only: ${ownerOnly} | requester only: ${reqOnly} | neither: ${neither}`);
console.log('  (owner-only is normal for a patent-owner-requested reexam — there is no third party;');
console.log('   neither means OCR interleaved the cover sheet columns and the names are not in the text.)');
try { await sql.end(); } catch { /* */ }
