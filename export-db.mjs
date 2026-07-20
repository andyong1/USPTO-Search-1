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

// One-line descriptions for the README manifest. Unlisted tables are still
// exported (just without a description).
const DESCRIPTIONS = {
  reexam_watch: 'Enumerated ex parte reexamination control numbers (filing date, series 90/ or 96/) — the scan population.',
  reexam_determinations: 'Reexam determinations: orders (RXREXO / RX.SE.ORDER) and denials (RXREXD), with examiner, art unit, requester type, dates.',
  reexam_tech_center: 'Per reexam: the underlying patent/application it re-examines, its group art unit, and technology center (resolved via continuity).',
  reexam_conclusions: 'Conclusion of a reexam: the NIRC / certificate (RXCERT) documents and the claim disposition parsed from the certificate text.',
  reexam_doc_text: 'Full OCR text of reexam determination documents plus extracted grounds: prior-art references, PTAB-trial mentions, and §325(d) discussion level.',
  reexam_actions: 'Office-action timing per ordered reexam: first non-final (RXR.NF) and final (RXR.F) action dates.',
  reexam_preorder: 'Patent-owner pre-order SNQ submissions (RX.PRO.PO) filed on/after the Apr 5 2026 cutoff, plus any requestor petition/decision.',
  reexam_petitions: 'Patent-owner petitions and their 35 U.S.C. §325(d) detection state.',
  reexam_petition_scan: 'Bookkeeping: which reexams have been scanned for petitions, and when.',
  reexam_post_petitions: 'Post-order petitions on ordered reexams (patent-owner petition, requester opposition, Office decision) + OCR status.',
  reexam_doc_events: 'Append-only log of notable reexam documents as they were first detected (determinations, petitions, certificates, actions).',
  reexam_state: 'Singleton bookkeeping row: scan cursors, enumeration reconciliation counters, digest timestamps, classifier/logic versions.',
  seen_documents: 'Per-tracked-application ledger of document ids already seen, with first-seen timestamps (drives the "new finding" flag).',
  ptab_fwd: 'PTAB final-written-decision catalog (2024+): parties, dates, extracted text, classified outcome, discretionary-decision subtype, prior-art refs.',
  ptab_decisions: 'PTAB institution + Director-discretionary decision catalog (2024+): grant/deny, refer, dates, PDF links, extracted institution refs.',
  patent_proceedings: 'All-AIA-years PTAB proceedings (IPR/PGR/CBM) on each reexamined patent, discovered per-patent (links pre-2024 proceedings).',
  patent_proceedings_scan: 'Bookkeeping: which patents have been scanned for PTAB proceedings, and when.',
  patent_reexams: 'All ex parte reexaminations on each patent (any date), discovered via child-continuity REX links; used for prior/parallel-reexam display.',
  patent_reexams_scan: 'Bookkeeping: which underlying applications have been scanned for sibling reexams, and when.',
  ptab_petition_refs: 'Prior-art references extracted from each PTAB proceeding’s petition, keyed by trial number.',
  filings_daily: 'Daily filing counts by kind (ex parte reexam requests / IPR petitions) for the trends charts.',
  ptab_kv: 'Key/value store for PTAB scan cursors and small state (offsets, schema version, reported counts).',
};

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

let exported = 0; const skipped = []; const manifest = [];
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
  manifest.push({ t, rows: rows.length, cols });
  exported++;
}

// README manifest describing each exported table.
const stamp = new Date().toISOString().slice(0, 10);
const md = [
  '# USPTO Search — database export',
  '',
  `Generated ${stamp}. One \`.csv\` and one \`.json\` per table.`,
  '',
  'Source: a personal tracker built on the USPTO Open Data Portal and PTAB trials data. '
    + 'All contents are compiled from **public** patent/PTAB docket records via heuristic '
    + 'classification and OCR — informational only, not legal advice; verify against source documents.',
  '',
  '**Personal data excluded:** the digest-subscriber and alert-recipient email tables '
    + '(`reexam_subscribers`, `watched_applications`) are intentionally NOT included.',
  '',
  '## Formats',
  '- `.json` — array of row objects; native arrays/JSON for list & JSON columns.',
  '- `.csv` — same rows, Excel-friendly; list/JSON columns are serialized as JSON strings.',
  '',
  '## Tables',
  '',
  '| Table | Rows | Description |',
  '|---|---:|---|',
  ...manifest.map((m) => `| \`${m.t}\` | ${m.rows} | ${DESCRIPTIONS[m.t] || '—'} |`),
  '',
  '## Columns',
  '',
  ...manifest.flatMap((m) => [`**${m.t}** — ${m.cols.join(', ')}`, '']),
].join('\n');
await writeFile(`${OUT}/README.md`, md, 'utf-8');

console.log(`\nExported ${exported} tables to ${OUT}/ (CSV + JSON each) + README.md.`);
if (skipped.length) console.log('Skipped: ' + skipped.join('; '));
process.exit(0);
