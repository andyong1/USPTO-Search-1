// Deterministic (no AI): fill reexam_tech_center.patent_owner from the underlying
// application's applicant of record (ODP meta-data firstApplicantName). Resolves
// through the public /api/document-style proxy (/api/application), which injects
// the USPTO key server-side, so no local key is needed. New determinations get the
// owner during the normal tech-center resolution (lib/techcenter.js); this backfills
// the rows that were tech-center-resolved before the owner column existed.
//
// Requires POSTGRES_URL. Run from the uspto-search folder:
//     node owner-backfill.mjs --limit 300   (re-run until "0 still needing owner")
import { sql } from '@vercel/postgres';
import { getDeterminationsNeedingOwner, recordOwner, countDeterminationsNeedingOwner } from './lib/db.js';
import { pickAssignmentOwner } from './lib/uspto.js';

if (!process.env.POSTGRES_URL) {
  console.error('POSTGRES_URL is not set. Load it from grounds-secrets.env first.');
  process.exit(1);
}
const args = process.argv.slice(2);
const li = args.indexOf('--limit');
const LIMIT = li >= 0 ? Number(args[li + 1]) : 40;
const SITE = 'https://andy-ong.com';

const rows = await getDeterminationsNeedingOwner(LIMIT);
let done = 0, named = 0, noParent = 0, failed = 0;
for (const r of rows) {
  try {
    let owner = null;
    if (r.underlying_application) {
      const app = encodeURIComponent(r.underlying_application);
      const res = await fetch(`${SITE}/api/application?appNum=${app}&section=meta-data`);
      if (res.ok) {
        const j = await res.json();
        const rec = (j.patentFileWrapperDataBag && j.patentFileWrapperDataBag[0]) || j;
        const md = rec.applicationMetaData || {};
        owner = md.firstApplicantName
          || (Array.isArray(md.applicantBag) && md.applicantBag[0] && md.applicantBag[0].applicantNameText)
          || null;
      }
      // Fallback: latest ownership-transfer assignee (skips security interests).
      if (!owner) {
        const ar = await fetch(`${SITE}/api/application?appNum=${app}&section=assignment`);
        if (ar.ok) {
          const aj = await ar.json();
          const arec = (aj.patentFileWrapperDataBag && aj.patentFileWrapperDataBag[0]) || aj;
          owner = pickAssignmentOwner(arec.assignmentBag || arec.patentAssignmentBag || []) || null;
        }
      }
    } else { noParent++; }
    await recordOwner(r.application_number, owner);
    done++;
    if (owner) named++;
    if (done % 50 === 0) console.log(`  …${done}`);
  } catch (e) { failed++; console.error(`  ${r.application_number}: ${e.message}`); }
}
console.log(`Owners: ${done} processed (${named} named, ${noParent} no parent app, ${failed} failed). ${await countDeterminationsNeedingOwner()} still needing owner.`);
try { await sql.end(); } catch { /* already closed */ }
