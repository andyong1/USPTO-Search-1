// Export the Neon database to shareable files: every table (EXCEPT the two that
// hold personal data) written as BOTH a .csv and a .json into ./db-export/.
//
// Excluded — personal data:
//   reexam_subscribers    (digest email addresses + unsubscribe tokens)
//   watched_applications  (per-proceeding alert-recipient email addresses)
//
// Requires POSTGRES_URL in the environment. Run:
//   NODE_OPTIONS=--use-system-ca POSTGRES_URL=postgres://... node export-db.mjs
// Output goes to ./db-export/ (gitignored). Zip that folder and share it.

import { mkdir, writeFile } from 'node:fs/promises';
import { sql } from '@vercel/postgres';

if (!process.env.POSTGRES_URL) { console.error('POSTGRES_URL is not set.'); process.exit(1); }

// Tables holding personal data — never exported.
const EXCLUDE = new Set(['reexam_subscribers', 'watched_applications']);
const OUT = 'db-export';
const SAFE_IDENT = /^[a-z_][a-z0-9_]*$/; // guards the interpolated table name

// One CSV cell: null -> empty; Date -> ISO; array/object -> JSON; quote/escape
// only when the value contains a comma, quote, or newline.
function csvCell(v) {
  if (v == null) return '';
  let s;
  if (v instanceof Date) s = v.toISOString();
  else if (typeof v === 'object') s = JSON.stringify(v); // text[] arrays, jsonb
  else s = String(v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

await mkdir(OUT, { recursive: true });

const { rows: tables } = await sql.query(
  "SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name");

let exported = 0; const skipped = [];
for (const { table_name: t } of tables) {
  if (!SAFE_IDENT.test(t)) { skipped.push(`${t} (unsafe name)`); continue; }
  if (EXCLUDE.has(t)) { skipped.push(`${t} (personal data)`); continue; }

  // Column order from the catalog, so even empty tables get a proper CSV header.
  const { rows: colRows } = await sql.query(
    "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position", [t]);
  const cols = colRows.map((c) => c.column_name);

  const { rows } = await sql.query(`SELECT * FROM "${t}"`);

  await writeFile(`${OUT}/${t}.json`, JSON.stringify(rows, null, 2), 'utf-8');
  const csv = [cols.map(csvCell).join(',')]
    .concat(rows.map((r) => cols.map((c) => csvCell(r[c])).join(',')))
    .join('\r\n') + '\r\n';
  await writeFile(`${OUT}/${t}.csv`, csv, 'utf-8');

  console.log(`  ${t.padEnd(26)} ${rows.length} rows`);
  exported++;
}

console.log(`\nExported ${exported} tables to ${OUT}/ (CSV + JSON each).`);
if (skipped.length) console.log('Skipped: ' + skipped.join('; '));
process.exit(0);
