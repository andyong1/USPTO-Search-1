// ONE-OFF correction. The combined-petition pattern was mis-modelled: where the
// Office grants a 37 CFR 1.183 waiver so a § 325(d) paper can be filed and refers
// the § 325(d) question itself to the CRU, the earlier pass recorded
// merits_outcome='undecided' ("deferred"). That is wrong twice over:
//   * the petition WAS granted — the Office gave exactly the relief it decided; and
//   * nothing further is coming. The CRU answers § 325(d) in the reexamination
//     determination, never in a second petition decision, so a "deferred" row
//     would sit unresolved forever.
// So: merits_outcome -> 'granted', granted_relief records WHICH relief was granted,
// and referred_to_cru marks where the substantive question went (the determination,
// which the page now shows alongside).
//
// Safe by construction: every affected row has ancillary_waiver='granted', so the
// waiver grant is an established fact, not an inference.
//
//     set -a && . ./grounds-secrets.env && set +a && node petsubj-fix-referred.mjs [--dry-run]

import { sql } from '@vercel/postgres';
import { countDecisionsNeedingSubject } from './lib/db.js';

if (!process.env.POSTGRES_URL) { console.error('POSTGRES_URL is not set.'); process.exit(1); }
const DRY = process.argv.includes('--dry-run');

// This script writes raw SQL, so nothing would otherwise run ensureSchema() and
// create granted_relief / referred_to_cru. Touch a db.js helper first to apply
// pending migrations before the UPDATE references those columns.
await countDecisionsNeedingSubject();

const { rows: before } = await sql`
  SELECT merits_outcome, ancillary_waiver, count(*)::int n
  FROM reexam_petition_subject
  WHERE merits_outcome = 'undecided'
  GROUP BY 1, 2 ORDER BY n DESC`;
console.log('rows currently marked undecided/deferred:');
for (const r of before) console.log(`  ${String(r.n).padStart(4)}  merits=${r.merits_outcome}  waiver=${r.ancillary_waiver}`);

// Only touch the shape we understand: deferred WITH the waiver granted.
const { rows: odd } = await sql`
  SELECT count(*)::int n FROM reexam_petition_subject
  WHERE merits_outcome = 'undecided' AND coalesce(ancillary_waiver, '') <> 'granted'`;
if (odd[0].n) console.log(`\n${odd[0].n} deferred row(s) do NOT have a granted waiver — left untouched for review.`);

if (DRY) { console.log('\n--dry-run: no changes written.'); try { await sql.end(); } catch {} process.exit(0); }

const { rowCount } = await sql`
  UPDATE reexam_petition_subject
  SET merits_outcome = 'granted',
      granted_relief = 'waiver_or_suspension_of_rule',
      referred_to_cru = true,
      updated_at = now()
  WHERE merits_outcome = 'undecided' AND ancillary_waiver = 'granted'`;
console.log(`\nCorrected ${rowCount} row(s) → merits_outcome='granted', granted_relief='waiver_or_suspension_of_rule', referred_to_cru=true.`);

const { rows: after } = await sql`
  SELECT merits_outcome, count(*)::int n FROM reexam_petition_subject GROUP BY 1 ORDER BY n DESC`;
console.log('\nmerits outcome now:', after.map((r) => `${r.merits_outcome}=${r.n}`).join(' '));

// What the CRU actually did with the referred § 325(d) question.
const { rows: down } = await sql`
  SELECT
    count(*)::int total,
    count(*) FILTER (WHERE d.determination_code IN ('RXREXO','RX.SE.ORDER'))::int ordered_anyway,
    count(*) FILTER (WHERE d.determination_code IS NOT NULL
                       AND d.determination_code NOT IN ('RXREXO','RX.SE.ORDER'))::int not_ordered,
    count(*) FILTER (WHERE d.determination_code IS NULL)::int still_pending
  FROM reexam_petition_subject s
  LEFT JOIN (SELECT DISTINCT ON (application_number) application_number, determination_code
             FROM reexam_determinations ORDER BY application_number, official_date DESC) d
    ON d.application_number = s.application_number
  WHERE s.referred_to_cru`;
const d = down[0];
console.log(`\nreferred to the CRU: ${d.total} — reexam ordered anyway ${d.ordered_anyway}, not ordered ${d.not_ordered}, no determination yet ${d.still_pending}`);
if (d.ordered_anyway + d.not_ordered) {
  console.log(`  patent owner prevailed on § 325(d) at the determination in ${d.not_ordered} of ${d.ordered_anyway + d.not_ordered} decided (${Math.round(d.not_ordered / (d.ordered_anyway + d.not_ordered) * 100)}%).`);
}
try { await sql.end(); } catch { /* */ }
