// Postgres helpers (Vercel Postgres / Neon). The @vercel/postgres client reads
// its connection string from POSTGRES_URL, injected automatically when you add
// the Postgres integration in the Vercel dashboard.

import { sql } from '@vercel/postgres';
import { randomUUID } from 'node:crypto';
import { fetchDocuments } from './uspto.js';

let schemaReady = false;
let schemaPromise = null;

// Bump this WHENEVER you change runMigrations() (new table/column/etc.). The gate
// below skips the whole DDL chain when the DB already reports this version, so a
// stale value would leave new DDL unapplied on existing databases.
const SCHEMA_VERSION = '2026-07-18.9';

export async function ensureSchema() {
  if (schemaReady) return;
  // Single-flight: on a cold start, concurrent callers (e.g. a Promise.all of
  // several queries) await one run instead of each re-checking. On failure the
  // promise is cleared so the next call retries.
  if (!schemaPromise) schemaPromise = ensureSchemaOnce().then(() => { schemaReady = true; }).finally(() => { schemaPromise = null; });
  return schemaPromise;
}

async function ensureSchemaOnce() {
  // Cheap version gate: one round-trip to check whether the DB is already at the
  // current schema version, so warm-version cold starts skip the ~25 idempotent
  // CREATE/ALTER round-trips runMigrations() would otherwise issue.
  try {
    const { rows } = await sql`SELECT v FROM ptab_kv WHERE k = 'schema_version' LIMIT 1`;
    if (rows[0] && rows[0].v === SCHEMA_VERSION) return;
  } catch { /* ptab_kv doesn't exist yet on a fresh DB — fall through to migrate */ }
  await runMigrations();
  // Stamp the version so subsequent cold starts short-circuit (ptab_kv is created
  // by runMigrations, so this upsert is safe here). Best-effort.
  try {
    await sql`INSERT INTO ptab_kv (k, v, updated_at) VALUES ('schema_version', ${SCHEMA_VERSION}, now())
              ON CONFLICT (k) DO UPDATE SET v = ${SCHEMA_VERSION}, updated_at = now()`;
  } catch { /* if the stamp fails we simply re-migrate next cold start */ }
}

async function runMigrations() {
  await sql`CREATE TABLE IF NOT EXISTS watched_applications (
    application_number text PRIMARY KEY,
    label              text,
    recipients         text,
    created_at         timestamptz NOT NULL DEFAULT now()
  )`;
  // Add recipients to tables created before this column existed.
  await sql`ALTER TABLE watched_applications ADD COLUMN IF NOT EXISTS recipients text`;
  await sql`CREATE TABLE IF NOT EXISTS seen_documents (
    application_number  text    NOT NULL,
    document_identifier text    NOT NULL,
    document_code       text,
    description         text,
    official_date       text,
    direction           text,
    formats             text,
    is_new              boolean NOT NULL DEFAULT true,
    first_seen_at       timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (application_number, document_identifier)
  )`;

  // ── Reexamination determinations watcher ──
  await sql`CREATE TABLE IF NOT EXISTS reexam_watch (
    application_number text PRIMARY KEY,
    filing_date        text,
    determined         boolean NOT NULL DEFAULT false,
    last_scanned_at    timestamptz,
    created_at         timestamptz NOT NULL DEFAULT now()
  )`;
  await sql`CREATE TABLE IF NOT EXISTS reexam_determinations (
    application_number  text NOT NULL,
    document_identifier text NOT NULL,
    determination_code  text,
    determination_type  text,
    official_date       text,
    group_art_unit      text,
    examiner_name       text,
    notified            boolean NOT NULL DEFAULT false,
    found_at            timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (application_number, document_identifier)
  )`;
  await sql`ALTER TABLE reexam_determinations ADD COLUMN IF NOT EXISTS group_art_unit text`;
  await sql`ALTER TABLE reexam_determinations ADD COLUMN IF NOT EXISTS examiner_name text`;
  await sql`ALTER TABLE reexam_determinations ADD COLUMN IF NOT EXISTS requester_type text`;
  await sql`CREATE TABLE IF NOT EXISTS reexam_state (
    id                 int PRIMARY KEY DEFAULT 1,
    last_enumerated_at timestamptz,
    last_digest_at     timestamptz
  )`;
  await sql`INSERT INTO reexam_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING`;
  // Date (YYYY-MM-DD) of the last day a subscriber digest was sent — for idempotency.
  await sql`ALTER TABLE reexam_state ADD COLUMN IF NOT EXISTS last_sub_digest_date text`;
  // Date (YYYY-MM-DD) of the last day the owner digest was sent — for idempotency.
  await sql`ALTER TABLE reexam_state ADD COLUMN IF NOT EXISTS owner_digest_date text`;
  // Version of the requester-type detection logic last applied. Bumping it in the
  // cron forces a one-time reclassification of every determination (see below).
  await sql`ALTER TABLE reexam_state ADD COLUMN IF NOT EXISTS requester_logic_v int DEFAULT 0`;
  // Pre-order coverage denominators (reexams filed since the cutoff, and those
  // whose 30-day pre-order window has elapsed). Precomputed daily by the cron so
  // the pre-order page does not make live USPTO search calls on every view.
  await sql`ALTER TABLE reexam_state ADD COLUMN IF NOT EXISTS preorder_total_filed int`;
  await sql`ALTER TABLE reexam_state ADD COLUMN IF NOT EXISTS preorder_deadline_passed int`;
  await sql`ALTER TABLE reexam_state ADD COLUMN IF NOT EXISTS preorder_counts_at timestamptz`;
  // Enumeration reconciliation (DA-2/DA-3): what the API reported vs. what we
  // fetched vs. what the DB holds for the same filing-date window — surfaced on
  // /status so a truncated or false-zero enumeration is visible, not silent.
  await sql`ALTER TABLE reexam_state ADD COLUMN IF NOT EXISTS enum_reported int`;
  await sql`ALTER TABLE reexam_state ADD COLUMN IF NOT EXISTS enum_fetched int`;
  await sql`ALTER TABLE reexam_state ADD COLUMN IF NOT EXISTS enum_db_count int`;
  await sql`ALTER TABLE reexam_state ADD COLUMN IF NOT EXISTS enum_window_from text`;
  await sql`ALTER TABLE reexam_state ADD COLUMN IF NOT EXISTS enum_at timestamptz`;
  await sql`ALTER TABLE reexam_state ADD COLUMN IF NOT EXISTS enum_complete boolean`;

  // Ledger of relevant documents the moment we first detect them, for the owner's
  // daily digest. The PK makes re-detection a no-op (discovered_at = first sight).
  await sql`CREATE TABLE IF NOT EXISTS reexam_doc_events (
    category           text NOT NULL,
    application_number text NOT NULL,
    document_id        text NOT NULL,
    doc_code           text,
    official_date      text,
    label              text,
    discovered_at      timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (category, application_number, document_id)
  )`;

  // Public daily-notification subscribers for reexam determinations.
  await sql`CREATE TABLE IF NOT EXISTS reexam_subscribers (
    email      text PRIMARY KEY,
    token      text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  )`;

  // Patent owner pre-order SNQ submissions (document code RX.PRO.PO), plus any
  // requestor petition (RXPET*) within 20 days and its decision (RXPTD*).
  await sql`CREATE TABLE IF NOT EXISTS reexam_preorder (
    application_number  text NOT NULL,
    document_identifier text NOT NULL,
    official_date       text,
    filing_date         text,
    petition_doc_id     text,
    petition_date       text,
    decision_doc_id     text,
    decision_date       text,
    decision_outcome    text,
    found_at            timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (application_number, document_identifier)
  )`;
  await sql`ALTER TABLE reexam_preorder ADD COLUMN IF NOT EXISTS petition_doc_id text`;
  await sql`ALTER TABLE reexam_preorder ADD COLUMN IF NOT EXISTS petition_date text`;
  await sql`ALTER TABLE reexam_preorder ADD COLUMN IF NOT EXISTS decision_doc_id text`;
  await sql`ALTER TABLE reexam_preorder ADD COLUMN IF NOT EXISTS decision_date text`;
  await sql`ALTER TABLE reexam_preorder ADD COLUMN IF NOT EXISTS decision_outcome text`;
  await sql`ALTER TABLE reexam_watch ADD COLUMN IF NOT EXISTS preorder_checked boolean`;
  // Timestamp of the last pre-order backfill check (replaces the one-time
  // preorder_checked flag) so a recurring backfill re-checks on a 2-day cooldown.
  await sql`ALTER TABLE reexam_watch ADD COLUMN IF NOT EXISTS preorder_checked_at timestamptz`;
  // Application-number series ('90' ordinary EPR request, '96' supplemental-exam-
  // resulting EPR). Official request-filing statistics stay scoped to 90/; the
  // 96/ population exists for determination/outcome reporting (DA-4).
  await sql`ALTER TABLE reexam_watch ADD COLUMN IF NOT EXISTS series text`;
  await sql`UPDATE reexam_watch SET series = left(regexp_replace(application_number, '[^0-9]', '', 'g'), 2) WHERE series IS NULL`;

  // Conclusion of a reexamination: the NIRC / certificate documents and the
  // claim disposition parsed from their PDF text (best-effort).
  await sql`CREATE TABLE IF NOT EXISTS reexam_conclusions (
    application_number text PRIMARY KEY,
    nirc_doc_id        text,
    nirc_date          text,
    cert_doc_id        text,
    cert_date          text,
    outcome_summary    text,
    claims_confirmed   text,
    claims_cancelled   text,
    claims_amended     text,
    claims_new         text,
    parsed             boolean NOT NULL DEFAULT false,
    checked_at         timestamptz,
    found_at           timestamptz NOT NULL DEFAULT now()
  )`;
  // RXCERT doc ids found NOT to belong to this proceeding (e.g. another patent's
  // certificate filed as an exhibit), so detection skips them when picking the cert.
  await sql`ALTER TABLE reexam_conclusions ADD COLUMN IF NOT EXISTS cert_rejected_ids text`;
  // Cached OCR text of the certificate, so re-parsing (after a parser improvement)
  // is instant and never re-OCRs. Stored the first time the certificate is read.
  await sql`ALTER TABLE reexam_conclusions ADD COLUMN IF NOT EXISTS cert_text text`;
  // Which OCR.space engine produced cert_text ('1' or '2'); NULL = engine 1 / legacy.
  // Lets an Engine-2 sweep skip certificates already OCR'd with the better engine.
  await sql`ALTER TABLE reexam_conclusions ADD COLUMN IF NOT EXISTS cert_ocr_engine text`;

  // Technology center of the patent a reexam is re-examining. Resolved by a
  // two-hop lookup: reexam continuity -> underlying application (claimParentageType
  // "REX") -> that application's group art unit -> TC (first two digits + "00").
  await sql`CREATE TABLE IF NOT EXISTS reexam_tech_center (
    application_number     text PRIMARY KEY,
    underlying_application text,
    underlying_patent      text,
    group_art_unit         text,
    tech_center            text,
    checked_at             timestamptz
  )`;

  // Post-grant patent owner petitions (PET.OP filed after a reexam was ordered),
  // e.g. requests to reconsider the grant / terminate under 35 U.S.C. 325(d).
  await sql`CREATE TABLE IF NOT EXISTS reexam_petitions (
    application_number  text NOT NULL,
    document_identifier text NOT NULL,
    petition_date       text,
    order_date          text,
    is_325d             boolean,
    parsed              boolean NOT NULL DEFAULT false,
    found_at            timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (application_number, document_identifier)
  )`;
  await sql`ALTER TABLE reexam_petitions ADD COLUMN IF NOT EXISTS page_count int`;
  await sql`ALTER TABLE reexam_petitions ADD COLUMN IF NOT EXISTS petition_score int`;
  // Tracks which ordered reexams have been scanned for PET.OP petitions.
  await sql`CREATE TABLE IF NOT EXISTS reexam_petition_scan (
    application_number text PRIMARY KEY,
    checked_at         timestamptz
  )`;
  // One row per proceeding: the patent owner petition (PET.OP) filed after the
  // reexam order, plus any requester opposition (RXPET.) and Office decision.
  await sql`CREATE TABLE IF NOT EXISTS reexam_post_petitions (
    application_number text PRIMARY KEY,
    order_date         text,
    petition_doc_id    text,
    petition_date      text,
    petition_pages     int,
    opposition_doc_id  text,
    opposition_date    text,
    decision_doc_id    text,
    decision_date      text,
    decision_outcome   text,
    found_at           timestamptz NOT NULL DEFAULT now()
  )`;
  // Office action timing per ordered reexam: dates of the first non-final (RXR.NF)
  // and final (RXR.F) actions, measured from the reexam-ordered date.
  await sql`CREATE TABLE IF NOT EXISTS reexam_actions (
    application_number text PRIMARY KEY,
    order_date         text,
    nonf_date          text,
    finl_date          text,
    checked_at         timestamptz,
    found_at           timestamptz NOT NULL DEFAULT now()
  )`;
  await sql`ALTER TABLE reexam_actions ADD COLUMN IF NOT EXISTS nonf_doc_id text`;
  await sql`ALTER TABLE reexam_actions ADD COLUMN IF NOT EXISTS finl_doc_id text`;
  await sql`ALTER TABLE reexam_actions ADD COLUMN IF NOT EXISTS action_count int`;
  // Outlier flag (DA-11): same-day non-final+final dates or an implausible action
  // count — excluded from timing statistics and marked for review on the page.
  await sql`ALTER TABLE reexam_actions ADD COLUMN IF NOT EXISTS review_flag boolean`;
  // Whether the petition decision includes a 35 U.S.C. 325(d) analysis (from OCR),
  // the OCR job state, and a stored searchable-PDF URL.
  await sql`ALTER TABLE reexam_post_petitions ADD COLUMN IF NOT EXISTS decision_325d boolean`;
  await sql`ALTER TABLE reexam_post_petitions ADD COLUMN IF NOT EXISTS decision_ocr_status text`;
  await sql`ALTER TABLE reexam_post_petitions ADD COLUMN IF NOT EXISTS decision_ocr_job text`;
  await sql`ALTER TABLE reexam_post_petitions ADD COLUMN IF NOT EXISTS decision_pdf_blob_url text`;
  // Whether the PATENT OWNER PETITION itself cites 35 U.S.C. 325(d) (text-first,
  // OCR fallback). Only proceedings whose petition cites 325(d) are displayed.
  await sql`ALTER TABLE reexam_post_petitions ADD COLUMN IF NOT EXISTS petition_325d boolean`;
  await sql`ALTER TABLE reexam_post_petitions ADD COLUMN IF NOT EXISTS petition_325d_status text`;
  // Review flag (DA-11): the petition role was assigned from a same-date tie
  // between multiple candidate papers — verify before relying on timing.
  await sql`ALTER TABLE reexam_post_petitions ADD COLUMN IF NOT EXISTS review_flag boolean`;

  // ── PTAB AIA-trial Final Written Decisions (separate, standalone tracker) ──
  await sql`CREATE TABLE IF NOT EXISTS ptab_fwd (
    trial_number       text PRIMARY KEY,
    trial_type         text,
    patent_number      text,
    application_number text,
    tech_center        text,
    group_art_unit     text,
    po_name            text,
    petitioner_name    text,
    po_counsel         text,
    petitioner_counsel text,
    petition_date      text,
    institution_date   text,
    fwd_date           text,
    outcome            text,
    outcome_detail     text,
    fwd_doc_id         text,
    fwd_pdf_url        text,
    found_at           timestamptz NOT NULL DEFAULT now()
  )`;
  // Outcome is derived in two passes: (1) an expensive extract pass fetches the
  // FWD PDF and stores its text (decision_text, extracted_v, text_source); (2) a
  // cheap offline classify pass runs the classifier over that stored text
  // (classified_v). Storing the text lets us reprocess when the classifier
  // changes WITHOUT re-fetching every PDF.
  await sql`ALTER TABLE ptab_fwd ADD COLUMN IF NOT EXISTS classified_v int DEFAULT 0`;
  await sql`ALTER TABLE ptab_fwd ADD COLUMN IF NOT EXISTS text_source text`;
  await sql`ALTER TABLE ptab_fwd ADD COLUMN IF NOT EXISTS decision_text text`;
  await sql`ALTER TABLE ptab_fwd ADD COLUMN IF NOT EXISTS extracted_v int DEFAULT 0`;
  // Director discretionary decision (bifurcated DD process): subtype ('refer'/…)
  // or 'none'; dd_checked_v gates the backfill pass.
  await sql`ALTER TABLE ptab_fwd ADD COLUMN IF NOT EXISTS dd_decision text`;
  await sql`ALTER TABLE ptab_fwd ADD COLUMN IF NOT EXISTS dd_checked_v int DEFAULT 0`;
  // When a newer FWD-category record supersedes an already-classified FWD
  // (Director review / remand), the original outcome is stashed here instead of
  // silently lost; prior_outcome IS NOT NULL doubles as the review flag (DA-9).
  await sql`ALTER TABLE ptab_fwd ADD COLUMN IF NOT EXISTS prior_outcome text`;
  await sql`ALTER TABLE ptab_fwd ADD COLUMN IF NOT EXISTS prior_fwd_doc_id text`;
  await sql`ALTER TABLE ptab_fwd ADD COLUMN IF NOT EXISTS prior_fwd_date text`;
  // Small key/value store for PTAB pipeline heartbeats (e.g. maintain last-run).
  await sql`CREATE TABLE IF NOT EXISTS ptab_kv (k text PRIMARY KEY, v text, updated_at timestamptz DEFAULT now())`;
  // Daily filing counts for the (unlinked) filings-trends page: kind = 'reexam'
  // (ex parte 90/* applications) or 'ipr' (IPR petitions), d = 'YYYY-MM-DD'. The
  // page aggregates these to day/week/month for whatever range each chart selects.
  await sql`CREATE TABLE IF NOT EXISTS filings_daily (kind text, d text, count int, updated_at timestamptz DEFAULT now(), PRIMARY KEY (kind, d))`;
  // PTAB discretion / institution decisions tracker (separate dataset from ptab_fwd):
  // per proceeding, the Director discretionary decision (deny/refer) and the Board's
  // institution decision (granted/denied), each with its date + PDF. Both come
  // straight from the API metadata — no PDF extraction needed.
  await sql`CREATE TABLE IF NOT EXISTS ptab_decisions (
    trial_number       text PRIMARY KEY,
    trial_type         text,
    patent_number      text,
    application_number text,
    tech_center        text,
    group_art_unit     text,
    po_name            text,
    petitioner_name    text,
    petition_date      text,
    institution_date   text,
    dd_type            text,
    dd_date            text,
    dd_doc_id          text,
    dd_pdf_url         text,
    inst_type          text,
    inst_date          text,
    inst_doc_id        text,
    inst_pdf_url       text,
    found_at           timestamptz NOT NULL DEFAULT now()
  )`;

  // All PTAB proceedings (IPR/PGR/CBM) on a given patent, pulled per-patent from
  // the proceedings API with NO date bound (AIA trials since 2012) — this is how
  // the IPR→reexam pipeline links proceedings that predate the 2024 catalog cutoff.
  // status = trialStatusCategory (Institution Denied / Discretionary Denial / Final
  // Written Decision / Trial Instituted / Terminated-Settled / Terminated / Pending).
  await sql`CREATE TABLE IF NOT EXISTS patent_proceedings (
    trial_number     text PRIMARY KEY,
    patent_number    text,
    trial_type       text,
    petition_date    text,
    institution_date text,
    status           text,
    found_at         timestamptz NOT NULL DEFAULT now()
  )`;
  await sql`CREATE INDEX IF NOT EXISTS patent_proceedings_patent_idx ON patent_proceedings (patent_number)`;
  // Per-patent scan bookkeeping so ?pscan=1 is resumable and re-checks on a cadence.
  await sql`CREATE TABLE IF NOT EXISTS patent_proceedings_scan (
    patent_number text PRIMARY KEY,
    checked_at    timestamptz
  )`;

  // ALL ex parte reexaminations on a patent (any date), discovered via the
  // underlying application's child-continuity "REX" links — so the /reexam
  // "prior / parallel proceedings" column can show earlier reexams that predate
  // our tracking window. Kept SEPARATE from reexam_watch/reexam_determinations so
  // it never distorts the primary "reexams since <cutoff>" statistics.
  await sql`CREATE TABLE IF NOT EXISTS patent_reexams (
    control_number         text PRIMARY KEY,
    underlying_patent      text,
    underlying_application text,
    filing_date            text,
    determination_type     text,
    determination_date     text,
    found_at               timestamptz NOT NULL DEFAULT now()
  )`;
  await sql`CREATE INDEX IF NOT EXISTS patent_reexams_patent_idx ON patent_reexams (underlying_patent)`;
  await sql`CREATE TABLE IF NOT EXISTS patent_reexams_scan (
    underlying_application text PRIMARY KEY,
    checked_at             timestamptz
  )`;

  // Full text of reexam determination documents (orders/denials), OCR'd LOCALLY
  // and uploaded by the offline worker scripts — the server never OCRs these.
  // Feeds the grounds/prior-art overlap analysis vs. prior PTAB proceedings.
  // doc_kind is the worker's label ('order' | 'denial'); join reexam_determinations
  // on doc_id for the official document code.
  await sql`CREATE TABLE IF NOT EXISTS reexam_doc_text (
    doc_id             text PRIMARY KEY,
    application_number text NOT NULL,
    doc_kind           text,
    official_date      text,
    ocr_engine         text,
    page_count         int,
    char_count         int,
    text               text,
    uploaded_at        timestamptz NOT NULL DEFAULT now()
  )`;
  await sql`CREATE INDEX IF NOT EXISTS reexam_doc_text_app_idx ON reexam_doc_text (application_number)`;
  // Grounds extracted from the OCR text (lib/grounds.js): prior-art references and
  // PTAB-trial mentions, precomputed by the ?grounds=1 backfill so the compare
  // endpoint reads small arrays instead of re-parsing text. grounds_v gates re-runs.
  await sql`ALTER TABLE reexam_doc_text ADD COLUMN IF NOT EXISTS ref_numbers text[]`;
  await sql`ALTER TABLE reexam_doc_text ADD COLUMN IF NOT EXISTS trial_mentions text[]`;
  await sql`ALTER TABLE reexam_doc_text ADD COLUMN IF NOT EXISTS cites_325d boolean`;
  await sql`ALTER TABLE reexam_doc_text ADD COLUMN IF NOT EXISTS d325_level text`;
  await sql`ALTER TABLE reexam_doc_text ADD COLUMN IF NOT EXISTS grounds_v int DEFAULT 0`;
  // Prior-art references extracted from each PTAB final-written-decision's text,
  // for the same reexam-vs-PTAB overlap comparison.
  await sql`ALTER TABLE ptab_fwd ADD COLUMN IF NOT EXISTS ref_numbers text[]`;
  await sql`ALTER TABLE ptab_fwd ADD COLUMN IF NOT EXISTS grounds_v int DEFAULT 0`;
  // Prior-art references extracted from each PTAB INSTITUTION decision's text
  // (widens "same art" coverage to instituted/denied trials that never reached a
  // FWD). Only the small reference array is stored — not the decision text.
  await sql`ALTER TABLE ptab_decisions ADD COLUMN IF NOT EXISTS inst_ref_numbers text[]`;
  await sql`ALTER TABLE ptab_decisions ADD COLUMN IF NOT EXISTS inst_grounds_v int DEFAULT 0`;

  // Prior-art references cited in each proceeding's PETITION — the universal,
  // outcome-independent source of the asserted grounds (every trial has one, even
  // those denied at institution / discretionarily denied). Keyed by trial so it
  // spans all AIA years (via patent_proceedings). Only the ref array is stored.
  await sql`CREATE TABLE IF NOT EXISTS ptab_petition_refs (
    trial_number text PRIMARY KEY,
    pet_doc_id   text,
    ref_numbers  text[],
    grounds_v    int DEFAULT 0,
    checked_at   timestamptz NOT NULL DEFAULT now()
  )`;
  // Related district-court litigation from the petition's Related Matters section,
  // as jurisdiction shorthands — split into cases involving the petitioner vs.
  // other parties on the same patent (identified at petition filing).
  await sql`ALTER TABLE ptab_petition_refs ADD COLUMN IF NOT EXISTS lit_petitioner text[]`;
  await sql`ALTER TABLE ptab_petition_refs ADD COLUMN IF NOT EXISTS lit_other text[]`;
  // Petition front-matter text (first ~25KB — where Related Matters lives), stored
  // so litigation can be RE-parsed (bump LIT_V + run ?litrescan=1) without
  // re-downloading the petition. lit_v gates that cheap re-parse.
  await sql`ALTER TABLE ptab_petition_refs ADD COLUMN IF NOT EXISTS pet_frontmatter text`;
  await sql`ALTER TABLE ptab_petition_refs ADD COLUMN IF NOT EXISTS lit_v int DEFAULT 0`;
  // Front-matter storage version. Bump to force petrefs to RE-FETCH petitions and
  // re-store the front-matter window (e.g. after changing what/how much we store).
  await sql`ALTER TABLE ptab_petition_refs ADD COLUMN IF NOT EXISTS fm_v int DEFAULT 0`;
}

// Cutoff for the pre-order SNQ feature (reexams filed on/after this date).
export const PREORDER_CUTOFF = '2026-04-05';

// ── Reexamination watcher helpers ──────────────────────────────────
export async function reexamState() {
  await ensureSchema();
  const { rows } = await sql`SELECT last_enumerated_at, last_digest_at, requester_logic_v FROM reexam_state WHERE id = 1`;
  return rows[0] || {};
}

export async function setReexamEnumerated() {
  await sql`UPDATE reexam_state SET last_enumerated_at = now() WHERE id = 1`;
}

// Persist the enumeration reconciliation triple (DA-2/DA-3): API-reported count,
// rows fetched this run, and the DB count for the same filing-date window. The
// DB-side count is the check that catches cumulative drift (e.g. the audit's
// 494-vs-491 mismatch), not just single-run truncation. Returns the DB count.
export async function setEnumerationStats({ reported, fetched, windowFrom, complete }) {
  await ensureSchema();
  const { rows } = await sql`SELECT count(*)::int AS n FROM reexam_watch WHERE filing_date >= ${windowFrom}`;
  const dbCount = rows[0] ? rows[0].n : 0;
  await sql`UPDATE reexam_state SET
    enum_reported = ${reported ?? null}, enum_fetched = ${fetched ?? null},
    enum_db_count = ${dbCount}, enum_window_from = ${windowFrom},
    enum_at = now(), enum_complete = ${!!complete}
    WHERE id = 1`;
  return dbCount;
}

export async function setReexamDigestSent() {
  await sql`UPDATE reexam_state SET last_digest_at = now() WHERE id = 1`;
}

// Upsert a batch of reexam control numbers (ignore ones already present).
export async function upsertReexams(items) {
  await ensureSchema();
  if (!items.length) return;
  const values = [];
  const params = [];
  items.forEach((it, i) => {
    const series = String(it.applicationNumber || '').replace(/[^0-9]/g, '').slice(0, 2) || null;
    values.push(`($${i * 3 + 1},$${i * 3 + 2},$${i * 3 + 3})`);
    params.push(it.applicationNumber, it.filingDate || null, series);
  });
  // Correction-aware (DA-9): a USPTO filing-date correction must update the
  // stored row (DO NOTHING froze the first-seen value forever). COALESCE guards
  // against a page that omits the date nulling out a good one.
  const text =
    `INSERT INTO reexam_watch (application_number, filing_date, series)
     VALUES ${values.join(',')}
     ON CONFLICT (application_number) DO UPDATE SET
       filing_date = COALESCE(EXCLUDED.filing_date, reexam_watch.filing_date),
       series      = COALESCE(reexam_watch.series, EXCLUDED.series)`;
  await sql.query(text, params);
}

// Drop reexams filed before the given YYYY-MM-DD (past the determination window).
export async function pruneReexams(beforeFilingDate) {
  await ensureSchema();
  await sql`DELETE FROM reexam_watch WHERE filing_date IS NOT NULL AND filing_date < ${beforeFilingDate}`;
}

// Re-pool reexams filed on/after a date for re-scanning (determined = false), so
// a backfill can recapture any determinations that were missed. Returns count.
export async function resetReexamDeterminedSince(fromFilingDate) {
  await ensureSchema();
  const { rowCount } = await sql`
    UPDATE reexam_watch SET determined = false, last_scanned_at = NULL
    WHERE filing_date >= ${fromFilingDate}`;
  return rowCount;
}

// Next chunk to scan: least-recently-scanned, not-yet-determined reexams.
export async function getReexamScanBatch(limit) {
  await ensureSchema();
  const { rows } = await sql`
    SELECT application_number, filing_date FROM reexam_watch
    WHERE determined = false
    ORDER BY last_scanned_at ASC NULLS FIRST
    LIMIT ${limit}`;
  return rows;
}

// Reexams never scanned since the last re-pool (last_scanned_at IS NULL) — the
// pending pool for a determinations backfill campaign.
export async function getReexamsNeverScanned(limit) {
  await ensureSchema();
  const { rows } = await sql`
    SELECT application_number, filing_date FROM reexam_watch
    WHERE determined = false AND last_scanned_at IS NULL
    LIMIT ${limit}`;
  return rows;
}

export async function countUnscannedReexams() {
  await ensureSchema();
  const { rows } = await sql`
    SELECT count(*)::int AS n FROM reexam_watch
    WHERE determined = false AND last_scanned_at IS NULL`;
  return rows[0] ? rows[0].n : 0;
}

export async function markReexamScanned(appNum, determined) {
  await sql`UPDATE reexam_watch SET last_scanned_at = now(), determined = ${determined}
            WHERE application_number = ${appNum}`;
}

// ── Pre-order SNQ submissions ──────────────────────────────────────
export async function recordPreorder(d) {
  await ensureSchema();
  const { rowCount } = await sql`
    INSERT INTO reexam_preorder (application_number, document_identifier, official_date, filing_date)
    VALUES (${d.applicationNumber}, ${d.documentIdentifier}, ${d.officialDate || null}, ${d.filingDate || null})
    ON CONFLICT (application_number, document_identifier) DO NOTHING`;
  if (rowCount > 0) await logDocEvent('preorder_submission', d.applicationNumber, d.documentIdentifier, { code: 'RX.PRO.PO', officialDate: d.officialDate, label: 'Patent owner pre-order SNQ submission' });
  return rowCount > 0;
}

export async function listPreorder() {
  await ensureSchema();
  // Join the OPERATIVE (latest) reexam determination per proceeding, if any
  // (DA-1: a denial superseded by a later order must show the order).
  // One row per control number (dedup via DISTINCT ON, keeping the earliest
  // pre-order submission), then sorted by submission date descending and, within
  // a date, by control number descending — so the earliest date / earliest control
  // number sort to the bottom.
  const { rows } = await sql`
    SELECT * FROM (
      SELECT DISTINCT ON (p.application_number)
             p.application_number, p.document_identifier, p.official_date, p.filing_date,
             p.petition_doc_id, p.petition_date, p.decision_doc_id, p.decision_date, p.decision_outcome,
             d.determination_type, d.det_date, d.det_doc_id,
             c.cert_doc_id, c.cert_date, c.nirc_doc_id, c.nirc_date, c.outcome_summary
      FROM reexam_preorder p
      LEFT JOIN (
        SELECT DISTINCT ON (application_number) application_number,
               determination_type, official_date AS det_date, document_identifier AS det_doc_id
        FROM reexam_determinations
        ORDER BY application_number, official_date DESC NULLS LAST, document_identifier DESC
      ) d ON d.application_number = p.application_number
      LEFT JOIN reexam_conclusions c ON c.application_number = p.application_number
      WHERE p.filing_date >= ${PREORDER_CUTOFF}
      ORDER BY p.application_number, p.official_date ASC NULLS LAST
    ) t
    ORDER BY t.official_date DESC NULLS LAST, t.application_number DESC`;
  return rows;
}


// Compares determination outcomes for reexams filed on/after the cutoff: the
// rate among proceedings WITH a patent owner pre-order submission vs. all such
// reexams. "Denied" = no SNQ found (RXREXD); "Ordered" = reexam granted (RXREXO).
export async function preorderEffectStats() {
  await ensureSchema();
  // Proceeding grain (DA-1): use the operative (latest) determination per control
  // number — a denial later superseded by an order previously counted in BOTH
  // buckets. Scoped to series 90/ (DA-4): the API-derived coverage denominators
  // are 90/-only, so the numerators must be too.
  const { rows } = await sql`
    SELECT
      count(*) FILTER (WHERE d.determination_code = 'RXREXD')::int AS overall_denied,
      count(*) FILTER (WHERE d.determination_code = 'RXREXO')::int AS overall_ordered,
      count(*) FILTER (WHERE d.determination_code = 'RXREXD' AND p.application_number IS NOT NULL)::int AS preorder_denied,
      count(*) FILTER (WHERE d.determination_code = 'RXREXO' AND p.application_number IS NOT NULL)::int AS preorder_ordered
    FROM (
      SELECT DISTINCT ON (application_number) application_number, determination_code
      FROM reexam_determinations
      ORDER BY application_number, official_date DESC NULLS LAST, document_identifier DESC
    ) d
    JOIN reexam_watch w ON w.application_number = d.application_number
    LEFT JOIN (SELECT DISTINCT application_number FROM reexam_preorder) p
      ON p.application_number = d.application_number
    WHERE w.filing_date >= ${PREORDER_CUTOFF} AND coalesce(w.series, '90') = '90'`;
  return rows[0] || { overall_denied: 0, overall_ordered: 0, preorder_denied: 0, preorder_ordered: 0 };
}

// Update the petition/decision fields for a proceeding's pre-order record.
export async function updatePreorderPetition(appNum, petition, decision) {
  await ensureSchema();
  await sql`UPDATE reexam_preorder SET
      petition_doc_id  = ${petition ? petition.id : null},
      petition_date    = ${petition ? petition.date : null},
      decision_doc_id  = ${decision ? decision.id : null},
      decision_date    = ${decision ? decision.date : null},
      decision_outcome = ${decision ? decision.outcome : null}
    WHERE application_number = ${appNum}`;
  if (petition && petition.id) await logDocEvent('preorder_petition', appNum, petition.id, { code: 'RXPET', officialDate: petition.date, label: 'Requestor petition to respond (pre-order)' });
  if (decision && decision.id) await logDocEvent('preorder_decision', appNum, decision.id, { officialDate: decision.date, label: 'Pre-order petition decision' + (decision.outcome ? ' — ' + decision.outcome : '') });
}

// Reexams (filed on/after the cutoff) due for a pre-order re-check: never checked,
// or last checked more than 2 days ago, least-recently-checked first. The 2-day
// cooldown (vs the old one-time flag) lets a recurring backfill catch late
// pre-order petition decisions on already-determined proceedings.
export async function getReexamsForPreorderBackfill(limit) {
  await ensureSchema();
  const { rows } = await sql`
    SELECT application_number, filing_date FROM reexam_watch
    WHERE filing_date >= ${PREORDER_CUTOFF}
      AND coalesce(series, '90') = '90'
      AND (preorder_checked_at IS NULL OR preorder_checked_at < now() - interval '2 days')
    ORDER BY preorder_checked_at ASC NULLS FIRST
    LIMIT ${limit}`;
  return rows;
}

export async function markPreorderChecked(appNum) {
  await sql`UPDATE reexam_watch SET preorder_checked_at = now() WHERE application_number = ${appNum}`;
}

// Clear the pre-order cooldown so the next backfill re-scans all post-cutoff reexams.
export async function resetPreorderChecked() {
  await ensureSchema();
  const { rowCount } = await sql`
    UPDATE reexam_watch SET preorder_checked_at = NULL WHERE filing_date >= ${PREORDER_CUTOFF}`;
  return rowCount;
}

export async function countReexamsForPreorderBackfill() {
  await ensureSchema();
  const { rows } = await sql`
    SELECT count(*)::int AS n FROM reexam_watch
    WHERE filing_date >= ${PREORDER_CUTOFF}
      AND (preorder_checked_at IS NULL OR preorder_checked_at < now() - interval '2 days')`;
  return rows[0] ? rows[0].n : 0;
}

// Record a determination; returns true if it was newly inserted.
export async function recordDetermination(d) {
  await ensureSchema();
  const { rowCount } = await sql`
    INSERT INTO reexam_determinations
      (application_number, document_identifier, determination_code, determination_type,
       official_date, group_art_unit, examiner_name)
    VALUES (${d.applicationNumber}, ${d.documentIdentifier}, ${d.code}, ${d.type},
            ${d.officialDate}, ${d.groupArtUnit || null}, ${d.examiner || null})
    ON CONFLICT (application_number, document_identifier) DO NOTHING`;
  if (rowCount > 0) await logDocEvent('determination', d.applicationNumber, d.documentIdentifier, { code: d.code, officialDate: d.officialDate, label: d.type });
  return rowCount > 0;
}

// Backfill helpers: applications whose determinations lack group art unit /
// examiner (one row per application), and the update to fill them.
export async function getAppsMissingDeterminationMeta(limit) {
  await ensureSchema();
  const { rows } = await sql`
    SELECT DISTINCT application_number FROM reexam_determinations
    WHERE group_art_unit IS NULL
    LIMIT ${limit}`;
  return rows.map((r) => r.application_number);
}

export async function updateDeterminationMeta(appNum, groupArtUnit, examiner) {
  // Set to '' (not null) so the row is marked processed and not re-backfilled.
  await sql`UPDATE reexam_determinations
            SET group_art_unit = ${groupArtUnit || ''}, examiner_name = ${examiner || ''}
            WHERE application_number = ${appNum} AND group_art_unit IS NULL`;
}

// Requester type (patent owner vs third-party) for a proceeding — set on every
// determination row for the application. Stored as 'third_party' | 'patent_owner'
// | 'unknown' (see classifyRequester in lib/uspto.js).
export async function setRequesterType(appNum, type) {
  await ensureSchema();
  await sql`UPDATE reexam_determinations SET requester_type = ${type || 'unknown'}
            WHERE application_number = ${appNum}`;
}

// Applications whose determinations still lack a requester type (one row each),
// for the rolling backfill. A stored value (incl. 'unknown') marks it processed.
export async function getAppsMissingRequesterType(limit) {
  await ensureSchema();
  const { rows } = await sql`
    SELECT DISTINCT application_number FROM reexam_determinations
    WHERE requester_type IS NULL
    LIMIT ${limit}`;
  return rows.map((r) => r.application_number);
}

// One-time reclassification support: clear every stored requester type so the
// rolling backfill recomputes it with the current detection logic.
export async function resetRequesterTypes() {
  await ensureSchema();
  const { rowCount } = await sql`UPDATE reexam_determinations SET requester_type = NULL WHERE requester_type IS NOT NULL`;
  return rowCount;
}
export async function setRequesterLogicVersion(v) {
  await sql`UPDATE reexam_state SET requester_logic_v = ${v} WHERE id = 1`;
}

// ── PTAB FWD tracker ────────────────────────────────────────────────
// Metadata catalog upsert (cheap). Deliberately does NOT touch outcome/
// outcome_detail/text_source/classified_v on conflict, so the (separate)
// PDF-based classification isn't clobbered when the catalog is refreshed.
export async function upsertPtabFwdMeta(r) {
  await ensureSchema();
  await sql`
    INSERT INTO ptab_fwd (trial_number, trial_type, patent_number, application_number, tech_center,
      group_art_unit, po_name, petitioner_name, po_counsel, petitioner_counsel, petition_date,
      institution_date, fwd_date, fwd_doc_id, fwd_pdf_url, outcome, classified_v)
    VALUES (${r.trial_number}, ${r.trial_type}, ${r.patent_number}, ${r.application_number}, ${r.tech_center},
      ${r.group_art_unit}, ${r.po_name}, ${r.petitioner_name}, ${r.po_counsel}, ${r.petitioner_counsel}, ${r.petition_date},
      ${r.institution_date}, ${r.fwd_date}, ${r.fwd_doc_id}, ${r.fwd_pdf_url}, NULL, 0)
    ON CONFLICT (trial_number) DO UPDATE SET
      trial_type = EXCLUDED.trial_type, patent_number = EXCLUDED.patent_number,
      application_number = EXCLUDED.application_number, tech_center = EXCLUDED.tech_center,
      group_art_unit = EXCLUDED.group_art_unit, po_name = EXCLUDED.po_name,
      petitioner_name = EXCLUDED.petitioner_name, po_counsel = EXCLUDED.po_counsel,
      petitioner_counsel = EXCLUDED.petitioner_counsel, petition_date = EXCLUDED.petition_date,
      institution_date = EXCLUDED.institution_date,
      -- Keep only the LATEST FWD: Director review / remand can supersede an earlier
      -- FWD, and the decisions feed returns multiple "Final Written Decision" records.
      -- Only advance to a strictly newer decision (never let an older one clobber it).
      fwd_date    = CASE WHEN EXCLUDED.fwd_date > coalesce(ptab_fwd.fwd_date, '') THEN EXCLUDED.fwd_date    ELSE ptab_fwd.fwd_date    END,
      fwd_doc_id  = CASE WHEN EXCLUDED.fwd_date > coalesce(ptab_fwd.fwd_date, '') THEN EXCLUDED.fwd_doc_id  ELSE ptab_fwd.fwd_doc_id  END,
      fwd_pdf_url = CASE WHEN EXCLUDED.fwd_date > coalesce(ptab_fwd.fwd_date, '') THEN EXCLUDED.fwd_pdf_url ELSE ptab_fwd.fwd_pdf_url END,
      -- Re-extract + reclassify ONLY when the decision DOCUMENT actually changed
      -- (DA-9): a same-doc date correction no longer wipes a good classification.
      extracted_v  = CASE WHEN EXCLUDED.fwd_date > coalesce(ptab_fwd.fwd_date, '') AND EXCLUDED.fwd_doc_id IS DISTINCT FROM ptab_fwd.fwd_doc_id THEN 0 ELSE ptab_fwd.extracted_v  END,
      classified_v = CASE WHEN EXCLUDED.fwd_date > coalesce(ptab_fwd.fwd_date, '') AND EXCLUDED.fwd_doc_id IS DISTINCT FROM ptab_fwd.fwd_doc_id THEN 0 ELSE ptab_fwd.classified_v END,
      -- Preserve a superseded classification instead of silently losing it (DA-9);
      -- prior_outcome IS NOT NULL is the "superseded — review" signal on /ptab.
      prior_outcome    = CASE WHEN EXCLUDED.fwd_date > coalesce(ptab_fwd.fwd_date, '') AND EXCLUDED.fwd_doc_id IS DISTINCT FROM ptab_fwd.fwd_doc_id AND ptab_fwd.outcome IS NOT NULL THEN ptab_fwd.outcome    ELSE ptab_fwd.prior_outcome    END,
      prior_fwd_doc_id = CASE WHEN EXCLUDED.fwd_date > coalesce(ptab_fwd.fwd_date, '') AND EXCLUDED.fwd_doc_id IS DISTINCT FROM ptab_fwd.fwd_doc_id AND ptab_fwd.outcome IS NOT NULL THEN ptab_fwd.fwd_doc_id ELSE ptab_fwd.prior_fwd_doc_id END,
      prior_fwd_date   = CASE WHEN EXCLUDED.fwd_date > coalesce(ptab_fwd.fwd_date, '') AND EXCLUDED.fwd_doc_id IS DISTINCT FROM ptab_fwd.fwd_doc_id AND ptab_fwd.outcome IS NOT NULL THEN ptab_fwd.fwd_date   ELSE ptab_fwd.prior_fwd_date   END,
      outcome = CASE WHEN EXCLUDED.fwd_date > coalesce(ptab_fwd.fwd_date, '') AND EXCLUDED.fwd_doc_id IS DISTINCT FROM ptab_fwd.fwd_doc_id THEN NULL ELSE ptab_fwd.outcome END`;
}

// ── Extract pass: fetch the FWD PDF and store its text (expensive; network) ──
// FWDs still needing text extraction at the current extractor version.
export async function getPtabFwdToExtract(limit, extractV) {
  await ensureSchema();
  const { rows } = await sql`
    SELECT trial_number, fwd_pdf_url FROM ptab_fwd
    WHERE (extracted_v IS NULL OR extracted_v < ${extractV}) AND coalesce(fwd_pdf_url, '') <> ''
    ORDER BY fwd_date DESC NULLS LAST LIMIT ${limit}`;
  return rows;
}
export async function countPtabFwdToExtract(extractV) {
  await ensureSchema();
  const { rows } = await sql`SELECT count(*)::int AS n FROM ptab_fwd
    WHERE (extracted_v IS NULL OR extracted_v < ${extractV}) AND coalesce(fwd_pdf_url, '') <> ''`;
  return rows[0].n;
}
// Store the extracted text. Resets classified_v so the offline classify pass
// re-runs over the fresh text. Cap length defensively.
export async function setPtabFwdText(trial, text, source, extractV) {
  const t = String(text || '').slice(0, 200000);
  await sql`UPDATE ptab_fwd SET decision_text = ${t}, text_source = ${source || ''}, extracted_v = ${extractV}, classified_v = 0
            WHERE trial_number = ${trial}`;
}

// ── Classify pass: run the classifier over stored text (cheap; offline) ──
// Rows with extracted text but not yet classified at the current classifier version.
export async function getPtabFwdToClassify(limit, currentV) {
  await ensureSchema();
  const { rows } = await sql`
    SELECT trial_number, decision_text FROM ptab_fwd
    WHERE (classified_v IS NULL OR classified_v < ${currentV}) AND coalesce(extracted_v, 0) > 0
    ORDER BY fwd_date DESC NULLS LAST LIMIT ${limit}`;
  return rows;
}
export async function countPtabFwdToClassify(currentV) {
  await ensureSchema();
  const { rows } = await sql`SELECT count(*)::int AS n FROM ptab_fwd
    WHERE (classified_v IS NULL OR classified_v < ${currentV}) AND coalesce(extracted_v, 0) > 0`;
  return rows[0].n;
}
export async function setPtabFwdOutcome(trial, outcome, detail, v) {
  await sql`UPDATE ptab_fwd SET outcome = ${outcome}, outcome_detail = ${detail || ''}, classified_v = ${v}
            WHERE trial_number = ${trial}`;
}

export async function listPtabFwd() {
  await ensureSchema();
  const { rows } = await sql`SELECT * FROM ptab_fwd ORDER BY fwd_date DESC NULLS LAST, trial_number DESC`;
  return rows;
}
export async function getPtabFwdByTrial(trial) {
  await ensureSchema();
  const { rows } = await sql`SELECT * FROM ptab_fwd WHERE trial_number = ${trial} LIMIT 1`;
  return rows[0] || null;
}
// Backfill ptab_fwd.institution_date from the institution-decision document date
// captured in ptab_decisions (inst_date), for rows whose USPTO metadata institution
// date is blank (common for newer proceedings). Pure in-DB join — no USPTO calls.
// Returns the number of rows filled.
export async function backfillFwdInstitutionDates() {
  await ensureSchema();
  const { rowCount } = await sql`
    UPDATE ptab_fwd f
    SET institution_date = d.inst_date
    FROM ptab_decisions d
    WHERE f.trial_number = d.trial_number
      AND coalesce(f.institution_date, '') = ''
      AND coalesce(d.inst_date, '') <> ''`;
  return rowCount;
}
// ── Per-patent PTAB proceedings (all AIA years, for the IPR→reexam pipeline) ──
export async function upsertPatentProceeding(r) {
  await ensureSchema();
  await sql`
    INSERT INTO patent_proceedings (trial_number, patent_number, trial_type, petition_date, institution_date, status)
    VALUES (${r.trial_number}, ${r.patent_number}, ${r.trial_type}, ${r.petition_date}, ${r.institution_date}, ${r.status})
    ON CONFLICT (trial_number) DO UPDATE SET
      patent_number = EXCLUDED.patent_number, trial_type = EXCLUDED.trial_type,
      petition_date = EXCLUDED.petition_date, institution_date = EXCLUDED.institution_date,
      status = EXCLUDED.status`;
}
export async function listPatentProceedings() {
  await ensureSchema();
  const { rows } = await sql`SELECT trial_number, patent_number, trial_type, petition_date, institution_date, status FROM patent_proceedings`;
  return rows;
}
// Patents due for an all-AIA-years proceedings scan: never scanned, or last
// checked before `staleBefore`. Least-recently-checked first (resumable). Seeded
// from BOTH reexamined patents (for the IPR→reexam pipeline) AND every patent on
// the /ptab-decisions page (ptab_decisions + ptab_fwd), so each decision can show
// its patent's full proceeding history — including proceedings filed before our
// 2024 catalog cutoff.
export async function getPatentsToScanForProceedings(limit, staleBefore) {
  await ensureSchema();
  const { rows } = await sql`
    SELECT q.p AS patent, s.checked_at
    FROM (
      SELECT DISTINCT p FROM (
        SELECT underlying_patent AS p FROM reexam_tech_center WHERE coalesce(underlying_patent, '') <> ''
        UNION SELECT patent_number FROM ptab_decisions WHERE coalesce(patent_number, '') <> ''
        UNION SELECT patent_number FROM ptab_fwd WHERE coalesce(patent_number, '') <> ''
      ) uu
    ) q
    LEFT JOIN patent_proceedings_scan s ON s.patent_number = q.p
    WHERE (s.checked_at IS NULL OR s.checked_at < ${staleBefore})
    ORDER BY s.checked_at ASC NULLS FIRST
    LIMIT ${limit}`;
  return rows.map((r) => r.patent);
}
export async function markPatentProceedingsScanned(patent) {
  await sql`INSERT INTO patent_proceedings_scan (patent_number, checked_at) VALUES (${patent}, now())
            ON CONFLICT (patent_number) DO UPDATE SET checked_at = now()`;
}
// ── All-reexams-on-a-patent (prior/parallel reexam discovery) ──────
// Distinct underlying applications of our resolved reexams, least-recently
// scanned first, whose sibling-reexam list is stale (re-check ~every 30 days).
export async function getAppsToScanForReexams(limit, staleBefore) {
  await ensureSchema();
  const { rows } = await sql`
    SELECT DISTINCT tc.underlying_application AS app, tc.underlying_patent AS patent, s.checked_at
    FROM reexam_tech_center tc
    LEFT JOIN patent_reexams_scan s ON s.underlying_application = tc.underlying_application
    WHERE coalesce(tc.underlying_application, '') <> ''
      AND (s.checked_at IS NULL OR s.checked_at < ${staleBefore})
    ORDER BY s.checked_at ASC NULLS FIRST
    LIMIT ${limit}`;
  return rows.map((r) => ({ app: r.app, patent: r.patent }));
}
export async function markAppScannedForReexams(app) {
  await sql`INSERT INTO patent_reexams_scan (underlying_application, checked_at) VALUES (${app}, now())
            ON CONFLICT (underlying_application) DO UPDATE SET checked_at = now()`;
}
export async function upsertPatentReexam(r) {
  await sql`
    INSERT INTO patent_reexams (control_number, underlying_patent, underlying_application, filing_date, determination_type, determination_date)
    VALUES (${r.controlNumber}, ${r.underlyingPatent || null}, ${r.underlyingApplication || null}, ${r.filingDate || null}, ${r.determinationType || null}, ${r.determinationDate || null})
    ON CONFLICT (control_number) DO UPDATE SET
      underlying_patent      = COALESCE(EXCLUDED.underlying_patent, patent_reexams.underlying_patent),
      underlying_application = COALESCE(EXCLUDED.underlying_application, patent_reexams.underlying_application),
      filing_date            = COALESCE(EXCLUDED.filing_date, patent_reexams.filing_date),
      determination_type     = COALESCE(EXCLUDED.determination_type, patent_reexams.determination_type),
      determination_date     = COALESCE(EXCLUDED.determination_date, patent_reexams.determination_date)`;
}
// Map underlying_patent -> [ all reexams on that patent ], for the compare read.
export async function getPatentReexamsMap() {
  await ensureSchema();
  const { rows } = await sql`
    SELECT control_number, underlying_patent, filing_date, determination_type, determination_date
    FROM patent_reexams WHERE coalesce(underlying_patent, '') <> ''`;
  const map = new Map();
  for (const r of rows) {
    const k = String(r.underlying_patent).replace(/[^0-9A-Za-z]/g, '');
    if (!map.has(k)) map.set(k, []);
    map.get(k).push({ control: r.control_number, filingDate: r.filing_date, type: r.determination_type, date: r.determination_date });
  }
  return map;
}
export async function patentReexamsCoverage() {
  await ensureSchema();
  const { rows } = await sql`
    SELECT
      (SELECT count(DISTINCT underlying_application) FROM reexam_tech_center WHERE coalesce(underlying_application,'') <> '')::int AS total,
      (SELECT count(*) FROM patent_reexams_scan)::int AS scanned,
      (SELECT count(*) FROM patent_reexams)::int AS found`;
  return rows[0] || { total: 0, scanned: 0, found: 0 };
}

// Coverage: distinct reexam patents total vs. how many have been scanned at least once.
export async function patentProceedingsCoverage() {
  await ensureSchema();
  const { rows } = await sql`
    SELECT
      (SELECT count(DISTINCT tc.underlying_patent) FROM reexam_tech_center tc
         JOIN reexam_determinations d ON d.application_number = tc.application_number
        WHERE coalesce(tc.underlying_patent,'') <> '')::int AS total,
      (SELECT count(*) FROM patent_proceedings_scan)::int AS scanned`;
  return rows[0] || { total: 0, scanned: 0 };
}
// ── Grounds / prior-art overlap (reexam order text vs. PTAB FWD text) ──
// Current extractor version; bump to force re-extraction of stored text.
export const GROUNDS_V = 8;
// Litigation-extractor version — bump to re-parse related litigation from the
// stored petition front-matter (?litrescan=1) WITHOUT re-downloading petitions.
export const LIT_V = 4;
// Front-matter storage version — bump to make petrefs re-fetch petitions and
// re-store the front-matter window (v2 = section-window instead of blind prefix).
export const FM_V = 2;

// Reexam determination docs whose grounds haven't been extracted at the current
// version. Returns the stored OCR text for the ?grounds=1 backfill to parse.
export async function getDocsToExtractGrounds(limit) {
  await ensureSchema();
  const { rows } = await sql`
    SELECT doc_id, application_number, text FROM reexam_doc_text
    WHERE coalesce(grounds_v, 0) < ${GROUNDS_V}
    LIMIT ${limit}`;
  return rows;
}
// d325 is the classify325d level ('none' | 'recited' | 'substantive'); cites_325d
// is derived from it so the existing boolean flag keeps working.
export async function setDocGrounds(docId, refs, trials, d325) {
  const level = d325 || 'none';
  await sql`UPDATE reexam_doc_text
            SET ref_numbers = ${refs}, trial_mentions = ${trials},
                cites_325d = ${level !== 'none'}, d325_level = ${level}, grounds_v = ${GROUNDS_V}
            WHERE doc_id = ${docId}`;
}
export async function countDocsToExtractGrounds() {
  await ensureSchema();
  const { rows } = await sql`SELECT count(*)::int AS n FROM reexam_doc_text WHERE coalesce(grounds_v,0) < ${GROUNDS_V}`;
  return rows[0] ? rows[0].n : 0;
}

// PTAB FWDs with decision text but no current-version reference extraction.
export async function getFwdsToExtractGrounds(limit) {
  await ensureSchema();
  const { rows } = await sql`
    SELECT trial_number, decision_text FROM ptab_fwd
    WHERE coalesce(decision_text, '') <> '' AND coalesce(grounds_v, 0) < ${GROUNDS_V}
    LIMIT ${limit}`;
  return rows;
}
export async function setFwdGrounds(trialNumber, refs) {
  await sql`UPDATE ptab_fwd SET ref_numbers = ${refs}, grounds_v = ${GROUNDS_V} WHERE trial_number = ${trialNumber}`;
}
export async function countFwdsToExtractGrounds() {
  await ensureSchema();
  const { rows } = await sql`SELECT count(*)::int AS n FROM ptab_fwd WHERE coalesce(decision_text,'') <> '' AND coalesce(grounds_v,0) < ${GROUNDS_V}`;
  return rows[0] ? rows[0].n : 0;
}

// Read-time maps for the compare endpoint. Reexam side: per application, the
// union of references and trial mentions across its determination docs.
export async function getReexamGroundsMap() {
  await ensureSchema();
  const { rows } = await sql`
    SELECT application_number, ref_numbers, trial_mentions, cites_325d, d325_level FROM reexam_doc_text
    WHERE coalesce(grounds_v, 0) >= ${GROUNDS_V}`;
  const RANK = { none: 0, recited: 1, substantive: 2 };
  const map = new Map();
  for (const r of rows) {
    const e = map.get(r.application_number) || { refs: new Set(), trials: new Set(), cites325d: false, d325: 'none' };
    for (const x of r.ref_numbers || []) e.refs.add(x);
    for (const x of r.trial_mentions || []) e.trials.add(x);
    if (r.cites_325d) e.cites325d = true;
    const lv = r.d325_level || 'none';
    if ((RANK[lv] || 0) > (RANK[e.d325] || 0)) e.d325 = lv; // keep the most substantive across the app's docs
    map.set(r.application_number, e);
  }
  // Freeze to plain arrays for JSON/use downstream.
  const out = new Map();
  for (const [k, v] of map) out.set(k, { refs: [...v.refs], trials: [...v.trials], cites325d: v.cites325d, d325: v.d325 });
  return out;
}
// PTAB institution decisions whose references haven't been extracted (need a PDF
// download, so this runs in the network-bound ?instrefs=1 step, not ?grounds=1).
export async function getInstitutionsToExtractGrounds(limit) {
  await ensureSchema();
  const { rows } = await sql`
    SELECT trial_number, inst_pdf_url FROM ptab_decisions
    WHERE coalesce(inst_pdf_url, '') <> '' AND coalesce(inst_grounds_v, 0) < ${GROUNDS_V}
    LIMIT ${limit}`;
  return rows;
}
export async function setInstitutionGrounds(trialNumber, refs) {
  await sql`UPDATE ptab_decisions SET inst_ref_numbers = ${refs}, inst_grounds_v = ${GROUNDS_V} WHERE trial_number = ${trialNumber}`;
}
export async function countInstitutionsToExtractGrounds() {
  await ensureSchema();
  const { rows } = await sql`SELECT count(*)::int AS n FROM ptab_decisions WHERE coalesce(inst_pdf_url,'') <> '' AND coalesce(inst_grounds_v,0) < ${GROUNDS_V}`;
  return rows[0] ? rows[0].n : 0;
}

// Trials whose petition refs / related litigation haven't been extracted at the
// current version — for the network-bound ?petrefs=1 step. The trial universe is
// the UNION of the decisions catalog (ptab_decisions — every institution/DD since
// 2024, the /ptab-decisions rows), the FWD catalog (ptab_fwd), and the all-AIA-
// years reexam linkage (patent_proceedings). Carries the petitioner name so
// litigation can be split petitioner-vs-other at extraction time.
export async function getTrialsToExtractPetitionRefs(limit) {
  await ensureSchema();
  const { rows } = await sql`
    SELECT u.trial_number, max(u.petitioner_name) AS petitioner_name, max(u.po_name) AS po_name
    FROM (
      SELECT trial_number, petitioner_name, po_name FROM ptab_decisions
      UNION ALL SELECT trial_number, petitioner_name, po_name FROM ptab_fwd
      UNION ALL SELECT trial_number, NULL::text, NULL::text FROM patent_proceedings
    ) u
    LEFT JOIN ptab_petition_refs pr ON pr.trial_number = u.trial_number
    WHERE coalesce(u.trial_number, '') <> ''
      AND (pr.trial_number IS NULL OR coalesce(pr.grounds_v, 0) < ${GROUNDS_V} OR coalesce(pr.fm_v, 0) < ${FM_V})
    GROUP BY u.trial_number
    LIMIT ${limit}`;
  return rows;
}
// Store a trial's petition references + related district-court litigation (by
// jurisdiction shorthand, split petitioner vs. other). Empty arrays mark "checked,
// none found". petDocId null when no petition doc was located.
export async function setPetitionRefs(trialNumber, refs, petDocId, litPetitioner, litOther, frontmatter) {
  // Strip NUL bytes (0x00) — some PDFs make pdf-parse emit them, and Postgres text
  // columns reject them ("invalid byte sequence for encoding UTF8: 0x00").
  const clean = (s) => String(s == null ? '' : s).replace(/\u0000/g, '');
  const cleanArr = (a) => (a || []).map(clean);
  const fm = clean(frontmatter);
  await sql`
    INSERT INTO ptab_petition_refs (trial_number, pet_doc_id, ref_numbers, lit_petitioner, lit_other, pet_frontmatter, grounds_v, lit_v, fm_v, checked_at)
    VALUES (${trialNumber}, ${petDocId || null}, ${cleanArr(refs)}, ${cleanArr(litPetitioner)}, ${cleanArr(litOther)}, ${fm || null}, ${GROUNDS_V}, ${LIT_V}, ${FM_V}, now())
    ON CONFLICT (trial_number) DO UPDATE SET
      pet_doc_id = EXCLUDED.pet_doc_id, ref_numbers = EXCLUDED.ref_numbers,
      lit_petitioner = EXCLUDED.lit_petitioner, lit_other = EXCLUDED.lit_other,
      pet_frontmatter = EXCLUDED.pet_frontmatter, grounds_v = EXCLUDED.grounds_v, lit_v = EXCLUDED.lit_v, fm_v = EXCLUDED.fm_v, checked_at = now()`;
}
// Cheap litigation re-parse (no petition re-download): rows with stored front-
// matter whose lit_v is behind. Carries petitioner name for the party split.
export async function getPetitionsToRelit(limit) {
  await ensureSchema();
  const { rows } = await sql`
    SELECT pr.trial_number, pr.pet_frontmatter,
           coalesce(d.petitioner_name, f.petitioner_name) AS petitioner_name,
           coalesce(d.po_name, f.po_name) AS po_name
    FROM ptab_petition_refs pr
    LEFT JOIN ptab_decisions d ON d.trial_number = pr.trial_number
    LEFT JOIN ptab_fwd f ON f.trial_number = pr.trial_number
    WHERE coalesce(pr.pet_frontmatter, '') <> '' AND coalesce(pr.lit_v, 0) < ${LIT_V}
    LIMIT ${limit}`;
  return rows;
}
export async function setLitigation(trialNumber, litPetitioner, litOther) {
  await sql`UPDATE ptab_petition_refs
            SET lit_petitioner = ${litPetitioner || []}, lit_other = ${litOther || []}, lit_v = ${LIT_V}
            WHERE trial_number = ${trialNumber}`;
}
export async function countPetitionsToRelit() {
  await ensureSchema();
  const { rows } = await sql`SELECT count(*)::int AS n FROM ptab_petition_refs WHERE coalesce(pet_frontmatter,'') <> '' AND coalesce(lit_v,0) < ${LIT_V}`;
  return rows[0] ? rows[0].n : 0;
}
// Read-time map for /ptab-decisions: trial -> { petitioner:[], other:[] } jurisdictions.
export async function getLitigationMap() {
  await ensureSchema();
  const { rows } = await sql`
    SELECT trial_number, lit_petitioner, lit_other FROM ptab_petition_refs
    WHERE coalesce(grounds_v, 0) >= ${GROUNDS_V} AND (lit_petitioner IS NOT NULL OR lit_other IS NOT NULL)`;
  const map = new Map();
  for (const r of rows) map.set(r.trial_number, { petitioner: r.lit_petitioner || [], other: r.lit_other || [] });
  return map;
}
export async function countTrialsToExtractPetitionRefs() {
  await ensureSchema();
  const { rows } = await sql`
    SELECT count(DISTINCT u.trial_number)::int AS n FROM (
      SELECT trial_number FROM ptab_decisions
      UNION ALL SELECT trial_number FROM ptab_fwd
      UNION ALL SELECT trial_number FROM patent_proceedings
    ) u
    LEFT JOIN ptab_petition_refs pr ON pr.trial_number = u.trial_number
    WHERE coalesce(u.trial_number,'') <> '' AND (pr.trial_number IS NULL OR coalesce(pr.grounds_v,0) < ${GROUNDS_V} OR coalesce(pr.fm_v,0) < ${FM_V})`;
  return rows[0] ? rows[0].n : 0;
}

// PTAB side for the compare endpoint: trial number -> extracted references. UNION
// of the petition refs (primary, outcome-independent) with the institution- and
// FWD-decision refs (already extracted; only ever add true-positive matches).
export async function getPtabGroundsMap() {
  await ensureSchema();
  const map = new Map();
  const add = (trial, refs) => {
    if (!trial) return;
    const s = map.get(trial) || new Set();
    for (const x of refs || []) s.add(x);
    map.set(trial, s);
  };
  const pet = await sql`SELECT trial_number, ref_numbers FROM ptab_petition_refs WHERE coalesce(grounds_v,0) >= ${GROUNDS_V} AND ref_numbers IS NOT NULL`;
  for (const r of pet.rows) add(r.trial_number, r.ref_numbers);
  const fwd = await sql`SELECT trial_number, ref_numbers FROM ptab_fwd WHERE coalesce(grounds_v,0) >= ${GROUNDS_V} AND ref_numbers IS NOT NULL`;
  for (const r of fwd.rows) add(r.trial_number, r.ref_numbers);
  const inst = await sql`SELECT trial_number, inst_ref_numbers FROM ptab_decisions WHERE coalesce(inst_grounds_v,0) >= ${GROUNDS_V} AND inst_ref_numbers IS NOT NULL`;
  for (const r of inst.rows) add(r.trial_number, r.inst_ref_numbers);
  const out = new Map();
  for (const [k, v] of map) out.set(k, [...v]);
  return out;
}

// Lean FWD list (no bulky decision_text) for cross-referencing / aggregate stats.
export async function listPtabFwdBrief() {
  await ensureSchema();
  const { rows } = await sql`SELECT trial_number, trial_type, patent_number, petition_date,
    institution_date, fwd_date, fwd_pdf_url, outcome, dd_decision FROM ptab_fwd
    ORDER BY fwd_date DESC NULLS LAST, trial_number DESC`;
  return rows;
}
// Heartbeat: record that the maintain orchestrator just ran (for the status strip).
export async function stampMaintainRun() {
  await ensureSchema();
  await sql`INSERT INTO ptab_kv (k, v, updated_at) VALUES ('maintain_last_run', now()::text, now())
            ON CONFLICT (k) DO UPDATE SET v = now()::text, updated_at = now()`;
}
export async function getMaintainLastRun() {
  await ensureSchema();
  const { rows } = await sql`SELECT updated_at FROM ptab_kv WHERE k = 'maintain_last_run' LIMIT 1`;
  return rows[0] ? rows[0].updated_at : null;
}
// Generic ptab_kv get/set (used for the rolling decisions-sweep cursor).
export async function getPtabKv(k) {
  await ensureSchema();
  const { rows } = await sql`SELECT v FROM ptab_kv WHERE k = ${k} LIMIT 1`;
  return rows[0] ? rows[0].v : null;
}
export async function setPtabKv(k, v) {
  await ensureSchema();
  await sql`INSERT INTO ptab_kv (k, v, updated_at) VALUES (${k}, ${v}, now())
            ON CONFLICT (k) DO UPDATE SET v = ${v}, updated_at = now()`;
}

// ── PTAB discretion / institution decisions ─────────────────────────
// Institution decision (granted/denied) for a proceeding. Metadata always
// updates; the inst_* fields only advance to a newer decision (Director Review can
// reverse), so scan order doesn't matter.
export async function upsertPtabInstitution(r) {
  await ensureSchema();
  await sql`
    INSERT INTO ptab_decisions (trial_number, trial_type, patent_number, application_number, tech_center,
      group_art_unit, po_name, petitioner_name, petition_date, institution_date, inst_type, inst_date, inst_doc_id, inst_pdf_url)
    VALUES (${r.trial_number}, ${r.trial_type}, ${r.patent_number}, ${r.application_number}, ${r.tech_center},
      ${r.group_art_unit}, ${r.po_name}, ${r.petitioner_name}, ${r.petition_date}, ${r.institution_date}, ${r.inst_type}, ${r.inst_date}, ${r.inst_doc_id}, ${r.inst_pdf_url})
    ON CONFLICT (trial_number) DO UPDATE SET
      trial_type = EXCLUDED.trial_type, patent_number = EXCLUDED.patent_number, application_number = EXCLUDED.application_number,
      tech_center = EXCLUDED.tech_center, group_art_unit = EXCLUDED.group_art_unit, po_name = EXCLUDED.po_name,
      petitioner_name = EXCLUDED.petitioner_name, petition_date = EXCLUDED.petition_date, institution_date = EXCLUDED.institution_date,
      inst_type    = CASE WHEN EXCLUDED.inst_date >= coalesce(ptab_decisions.inst_date, '') THEN EXCLUDED.inst_type    ELSE ptab_decisions.inst_type    END,
      inst_date    = CASE WHEN EXCLUDED.inst_date >= coalesce(ptab_decisions.inst_date, '') THEN EXCLUDED.inst_date    ELSE ptab_decisions.inst_date    END,
      inst_doc_id  = CASE WHEN EXCLUDED.inst_date >= coalesce(ptab_decisions.inst_date, '') THEN EXCLUDED.inst_doc_id  ELSE ptab_decisions.inst_doc_id  END,
      inst_pdf_url = CASE WHEN EXCLUDED.inst_date >= coalesce(ptab_decisions.inst_date, '') THEN EXCLUDED.inst_pdf_url ELSE ptab_decisions.inst_pdf_url END`;
}
// Director discretionary decision (deny/refer) for a proceeding.
export async function upsertPtabDd(r) {
  await ensureSchema();
  await sql`
    INSERT INTO ptab_decisions (trial_number, trial_type, patent_number, application_number, tech_center,
      group_art_unit, po_name, petitioner_name, petition_date, institution_date, dd_type, dd_date, dd_doc_id, dd_pdf_url)
    VALUES (${r.trial_number}, ${r.trial_type}, ${r.patent_number}, ${r.application_number}, ${r.tech_center},
      ${r.group_art_unit}, ${r.po_name}, ${r.petitioner_name}, ${r.petition_date}, ${r.institution_date}, ${r.dd_type}, ${r.dd_date}, ${r.dd_doc_id}, ${r.dd_pdf_url})
    ON CONFLICT (trial_number) DO UPDATE SET
      trial_type = EXCLUDED.trial_type, patent_number = EXCLUDED.patent_number, application_number = EXCLUDED.application_number,
      tech_center = EXCLUDED.tech_center, group_art_unit = EXCLUDED.group_art_unit, po_name = EXCLUDED.po_name,
      petitioner_name = EXCLUDED.petitioner_name, petition_date = EXCLUDED.petition_date, institution_date = EXCLUDED.institution_date,
      dd_type    = CASE WHEN EXCLUDED.dd_date >= coalesce(ptab_decisions.dd_date, '') THEN EXCLUDED.dd_type    ELSE ptab_decisions.dd_type    END,
      dd_date    = CASE WHEN EXCLUDED.dd_date >= coalesce(ptab_decisions.dd_date, '') THEN EXCLUDED.dd_date    ELSE ptab_decisions.dd_date    END,
      dd_doc_id  = CASE WHEN EXCLUDED.dd_date >= coalesce(ptab_decisions.dd_date, '') THEN EXCLUDED.dd_doc_id  ELSE ptab_decisions.dd_doc_id  END,
      dd_pdf_url = CASE WHEN EXCLUDED.dd_date >= coalesce(ptab_decisions.dd_date, '') THEN EXCLUDED.dd_pdf_url ELSE ptab_decisions.dd_pdf_url END`;
}
export async function listPtabDecisions() {
  await ensureSchema();
  const { rows } = await sql`SELECT * FROM ptab_decisions
    ORDER BY greatest(coalesce(inst_date, ''), coalesce(dd_date, '')) DESC NULLS LAST, trial_number DESC`;
  return rows;
}

// ── Daily filing counts (filings-trends page) ───────────────────────
export async function upsertFilingCount(kind, d, count) {
  await ensureSchema();
  await sql`INSERT INTO filings_daily (kind, d, count, updated_at) VALUES (${kind}, ${d}, ${count}, now())
            ON CONFLICT (kind, d) DO UPDATE SET count = ${count}, updated_at = now()`;
}
export async function listFilings() {
  await ensureSchema();
  const { rows } = await sql`SELECT kind, d, count, updated_at FROM filings_daily ORDER BY d`;
  return rows;
}

// Director discretionary decision backfill. Proceedings instituted before the
// bifurcated-DD process (institution_date < cutoff) can't have one → bulk-mark
// 'none' without a fetch. The rest are checked per-trial.
export async function markOldFwdNoDD(v, cutoff) {
  await ensureSchema();
  const { rowCount } = await sql`UPDATE ptab_fwd SET dd_decision = 'none', dd_checked_v = ${v}
    WHERE (dd_checked_v IS NULL OR dd_checked_v < ${v}) AND coalesce(institution_date, '') <> '' AND institution_date < ${cutoff}`;
  return rowCount;
}
export async function getPtabFwdToCheckDD(limit, v, cutoff) {
  await ensureSchema();
  const { rows } = await sql`
    SELECT trial_number FROM ptab_fwd
    WHERE (dd_checked_v IS NULL OR dd_checked_v < ${v})
      AND (coalesce(institution_date, '') = '' OR institution_date >= ${cutoff})
    ORDER BY fwd_date DESC NULLS LAST LIMIT ${limit}`;
  return rows.map((r) => r.trial_number);
}
export async function countPtabFwdToCheckDD(v, cutoff) {
  await ensureSchema();
  const { rows } = await sql`SELECT count(*)::int AS n FROM ptab_fwd
    WHERE (dd_checked_v IS NULL OR dd_checked_v < ${v})
      AND (coalesce(institution_date, '') = '' OR institution_date >= ${cutoff})`;
  return rows[0].n;
}
export async function setPtabFwdDD(trial, dd, v) {
  await sql`UPDATE ptab_fwd SET dd_decision = ${dd}, dd_checked_v = ${v} WHERE trial_number = ${trial}`;
}

// Re-pool determinations whose group art unit ended up blank (so they get
// backfilled again). Returns how many rows were reset.
export async function resetEmptyDeterminationMeta() {
  await ensureSchema();
  const { rowCount } = await sql`
    UPDATE reexam_determinations
    SET group_art_unit = NULL, examiner_name = NULL
    WHERE COALESCE(group_art_unit, '') = ''`;
  return rowCount;
}

export async function getUnnotifiedDeterminations() {
  await ensureSchema();
  const { rows } = await sql`
    SELECT application_number, determination_type, official_date
    FROM reexam_determinations WHERE notified = false
    ORDER BY official_date DESC NULLS LAST, found_at DESC`;
  return rows;
}

export async function markAllDeterminationsNotified() {
  await sql`UPDATE reexam_determinations SET notified = true WHERE notified = false`;
}

// ── Underlying-patent technology center ────────────────────────────
// Determinations whose underlying-patent TC hasn't been resolved yet (no
// tech_center) and not checked in the last 14 days — the rolling pool.
// `series` optionally restricts to one application-number series (e.g. '96' to
// backfill only supplemental-exam-resulting EPRs); default '%' matches all.
export async function getDeterminationsToCheckTechCenter(limit, series) {
  await ensureSchema();
  const pat = series ? `${series}%` : '%';
  const { rows } = await sql`
    SELECT d.application_number
    FROM (SELECT DISTINCT application_number FROM reexam_determinations) d
    LEFT JOIN reexam_tech_center tc ON tc.application_number = d.application_number
    WHERE (tc.tech_center IS NULL OR tc.underlying_patent IS NULL)
      AND (tc.checked_at IS NULL OR tc.checked_at < now() - interval '14 days')
      AND d.application_number LIKE ${pat}
    ORDER BY tc.checked_at ASC NULLS FIRST
    LIMIT ${limit}`;
  return rows;
}
// Upsert the resolved technology center (and the underlying patent/application
// it came from); always stamps checked_at so failures back off for 14 days.
export async function recordTechCenter(appNum, t) {
  await ensureSchema();
  await sql`
    INSERT INTO reexam_tech_center (application_number, underlying_application, underlying_patent, group_art_unit, tech_center, checked_at)
    VALUES (${appNum}, ${t.underlyingApplication || null}, ${t.underlyingPatent || null}, ${t.groupArtUnit || null}, ${t.techCenter || null}, now())
    ON CONFLICT (application_number) DO UPDATE SET
      underlying_application = COALESCE(EXCLUDED.underlying_application, reexam_tech_center.underlying_application),
      underlying_patent      = COALESCE(EXCLUDED.underlying_patent,      reexam_tech_center.underlying_patent),
      group_art_unit         = COALESCE(EXCLUDED.group_art_unit,         reexam_tech_center.group_art_unit),
      tech_center            = COALESCE(EXCLUDED.tech_center,            reexam_tech_center.tech_center),
      checked_at             = now()`;
}
export async function countTechCenterToCheck(series) {
  await ensureSchema();
  const pat = series ? `${series}%` : '%';
  const { rows } = await sql`
    SELECT COUNT(*)::int AS n FROM (
      SELECT DISTINCT d.application_number
      FROM reexam_determinations d
      LEFT JOIN reexam_tech_center tc ON tc.application_number = d.application_number
      WHERE (tc.tech_center IS NULL OR tc.underlying_patent IS NULL)
        AND (tc.checked_at IS NULL OR tc.checked_at < now() - interval '14 days')
        AND d.application_number LIKE ${pat}
    ) q`;
  return rows[0].n;
}

// One-shot: series 96/ (supplemental examination) is requestable ONLY by the
// patent owner by statute (35 U.S.C. 257(a)), so classify all 96/ determinations
// directly — no per-application transactions call. Fills rows the determinations
// backfill left NULL and corrects any earlier 'unknown' guess. Returns rowCount.
export async function backfillSeries96Requester() {
  await ensureSchema();
  const { rowCount } = await sql`
    UPDATE reexam_determinations SET requester_type = 'patent_owner'
    WHERE application_number LIKE '96%'
      AND (requester_type IS NULL OR requester_type = 'unknown')`;
  return rowCount;
}
// Re-pool rows that were checked but aren't fully resolved — no tech center, or a
// tech center but no underlying patent (continuity lacked the patent number; the
// improved resolver now reads it from the parent app's metadata) — so they get
// retried now instead of waiting out the 14-day backoff.
export async function resetFailedTechCenter() {
  await ensureSchema();
  const { rowCount } = await sql`UPDATE reexam_tech_center SET checked_at = NULL WHERE tech_center IS NULL OR underlying_patent IS NULL`;
  return rowCount || 0;
}
// Diagnostic: partition tracked reexams by underlying-patent resolution state.
//   resolved       – underlying_patent present (linkable)
//   hasAppNoPatent – parent app found but no patent yet (Bucket A; the improved
//                    resolver fills these on the next backfill pass)
//   noParent       – checked, but continuity had no REX parent (Bucket B; needs a
//                    different resolution path)
//   unchecked      – not yet run through the tech-center backfill
export async function reexamPatentResolutionBreakdown() {
  await ensureSchema();
  const { rows } = await sql`
    SELECT
      count(*)::int AS total,
      count(*) FILTER (WHERE coalesce(tc.underlying_patent, '') <> '')::int AS resolved,
      count(*) FILTER (WHERE coalesce(tc.underlying_patent, '') = '' AND coalesce(tc.underlying_application, '') <> '')::int AS has_app_no_patent,
      count(*) FILTER (WHERE tc.application_number IS NOT NULL AND coalesce(tc.underlying_application, '') = '' AND coalesce(tc.underlying_patent, '') = '')::int AS no_parent,
      count(*) FILTER (WHERE tc.application_number IS NULL)::int AS unchecked
    FROM (SELECT DISTINCT application_number FROM reexam_determinations) d
    LEFT JOIN reexam_tech_center tc ON tc.application_number = d.application_number`;
  return rows[0] || { total: 0, resolved: 0, has_app_no_patent: 0, no_parent: 0, unchecked: 0 };
}

// ── Reexam conclusions (NIRC / certificate + parsed claim outcome) ──
// Ordered reexams (RXREXO) not yet concluded (no certificate found) and not
// checked within the last 7 days — the rolling pool to look for a NIRC/certificate.
export async function getDeterminationsToCheckConclusion(limit) {
  await ensureSchema();
  const { rows } = await sql`
    SELECT d.application_number, w.filing_date
    FROM (SELECT DISTINCT application_number FROM reexam_determinations WHERE determination_code IN ('RXREXO', 'RX.SE.ORDER')) d
    LEFT JOIN reexam_conclusions c ON c.application_number = d.application_number
    LEFT JOIN reexam_watch w ON w.application_number = d.application_number
    WHERE c.cert_doc_id IS NULL
      AND (c.checked_at IS NULL OR c.checked_at < now() - interval '2 days')
    ORDER BY c.checked_at ASC NULLS FIRST
    LIMIT ${limit}`;
  return rows;
}

// Record (upsert) the NIRC + reexamination-certificate documents for a proceeding.
// d.certCandidates is the list of all RXCERT docs ({id, date}); we pick the first
// that hasn't been rejected (an earlier OCR pass found it cited another
// proceeding). NIRC is recorded for pendency tracking but does NOT mark the
// proceeding concluded — only a validated RXCERT does. Always stamps checked_at;
// when the chosen certificate changes, parsed resets so the parse step re-runs.
export async function recordConclusionDocs(appNum, d) {
  await ensureSchema();
  const { rows: ex } = await sql`SELECT cert_doc_id, cert_rejected_ids FROM reexam_conclusions WHERE application_number = ${appNum}`;
  const rejected = new Set(String((ex[0] && ex[0].cert_rejected_ids) || '').split(',').map((s) => s.trim()).filter(Boolean));
  const candidates = Array.isArray(d.certCandidates) ? d.certCandidates : [];
  const chosen = candidates.find((c) => c && c.id && !rejected.has(c.id)) || null;
  const chosenId = chosen ? chosen.id : null;
  const chosenDate = (chosen && chosen.date) ? chosen.date : null;
  const certChanged = chosenId !== ((ex[0] && ex[0].cert_doc_id) || null);

  await sql`
    INSERT INTO reexam_conclusions (application_number, nirc_doc_id, nirc_date, cert_doc_id, cert_date, parsed, checked_at)
    VALUES (${appNum}, ${d.nircDocId || null}, ${d.nircDate || null}, ${chosenId}, ${chosenDate}, false, now())
    ON CONFLICT (application_number) DO UPDATE SET
      nirc_doc_id = COALESCE(EXCLUDED.nirc_doc_id, reexam_conclusions.nirc_doc_id),
      nirc_date   = COALESCE(EXCLUDED.nirc_date,   reexam_conclusions.nirc_date),
      cert_doc_id = ${chosenId},
      cert_date   = ${chosenDate},
      parsed      = CASE WHEN ${certChanged} THEN false ELSE reexam_conclusions.parsed END,
      checked_at  = now()`;
  if (chosenId && certChanged) await logDocEvent('certificate', appNum, chosenId, { code: 'RXCERT', officialDate: chosenDate, label: 'Reexamination certificate' });
}

// Mark an RXCERT as not belonging to this proceeding: remember the doc id (so the
// next detection skips it and tries any other RXCERT) and clear the cert so the
// proceeding is no longer shown concluded.
export async function markCertRejected(appNum, docId) {
  await ensureSchema();
  await sql`UPDATE reexam_conclusions SET
      cert_rejected_ids = NULLIF(trim(both ',' from COALESCE(cert_rejected_ids, '') || ',' || ${String(docId)}), ''),
      cert_doc_id = NULL,
      cert_date = NULL,
      parsed = false
    WHERE application_number = ${appNum}`;
}

// Conclusions with a certificate (RXCERT) but no parsed outcome AND no cached OCR
// text yet — the pool that still needs an OCR pass. NIRC-only proceedings are
// excluded; only the certificate determines the claim outcome / concluded status.
export async function getConclusionsToParse(limit) {
  await ensureSchema();
  const { rows } = await sql`
    SELECT application_number, cert_doc_id
    FROM reexam_conclusions
    WHERE parsed = false AND cert_doc_id IS NOT NULL AND cert_text IS NULL
    ORDER BY found_at ASC
    LIMIT ${limit}`;
  return rows;
}

// Conclusions with cached OCR text that need (re-)parsing — instant, no OCR. This
// is what ?outcomes=1&reparse=1 drains after a parser improvement.
export async function getConclusionsToReparse(limit) {
  await ensureSchema();
  const { rows } = await sql`
    SELECT application_number, cert_doc_id, cert_text
    FROM reexam_conclusions
    WHERE parsed = false AND cert_doc_id IS NOT NULL AND cert_text IS NOT NULL
    ORDER BY found_at ASC
    LIMIT ${limit}`;
  return rows;
}

// Total certificates still awaiting a parsed outcome (cached + needs-OCR).
export async function countConclusionsUnparsed() {
  await ensureSchema();
  const { rows } = await sql`
    SELECT count(*)::int AS n FROM reexam_conclusions
    WHERE parsed = false AND cert_doc_id IS NOT NULL`;
  return rows[0] ? rows[0].n : 0;
}

// Store the parsed outcome (and, when supplied, cache the OCR text + which engine
// produced it so future re-parses are instant). A null text leaves the cached
// text and engine untouched.
export async function setConclusionOutcome(appNum, o, text, engine) {
  await ensureSchema();
  const cached = text ? String(text).slice(0, 20000) : null;
  await sql`
    UPDATE reexam_conclusions SET
      outcome_summary  = ${o ? o.summary : null},
      claims_confirmed = ${o ? o.confirmed : null},
      claims_cancelled = ${o ? o.cancelled : null},
      claims_amended   = ${o ? o.amended : null},
      claims_new       = ${o ? o.added : null},
      cert_text        = COALESCE(${cached}, cert_text),
      cert_ocr_engine  = COALESCE(${cached ? String(engine || '1') : null}, cert_ocr_engine),
      parsed           = true
    WHERE application_number = ${appNum}`;
}

// Engine-2 sweep helpers ───────────────────────────────────────────
// Certificates not yet OCR'd with engine 2 (engine 1 / legacy / never-OCR'd).
export async function getCertsNeedingEngine2(limit) {
  await ensureSchema();
  const { rows } = await sql`
    SELECT application_number, cert_doc_id
    FROM reexam_conclusions
    WHERE cert_doc_id IS NOT NULL AND cert_ocr_engine IS DISTINCT FROM '2'
    ORDER BY found_at ASC
    LIMIT ${limit}`;
  return rows;
}

export async function countCertsNeedingEngine2() {
  await ensureSchema();
  const { rows } = await sql`
    SELECT count(*)::int AS n FROM reexam_conclusions
    WHERE cert_doc_id IS NOT NULL AND cert_ocr_engine IS DISTINCT FROM '2'`;
  return rows[0] ? rows[0].n : 0;
}

// Record an engine-2 OCR that produced NO parseable outcome: cache the better
// text and mark engine=2 (so the sweep won't redo it) but DO NOT wipe a good
// outcome an earlier engine-1 pass may have captured.
export async function markCertEngine2(appNum, text) {
  await ensureSchema();
  const cached = text ? String(text).slice(0, 20000) : null;
  await sql`
    UPDATE reexam_conclusions SET
      cert_text       = COALESCE(${cached}, cert_text),
      cert_ocr_engine = '2',
      parsed          = true
    WHERE application_number = ${appNum}`;
}

// Re-pool conclusions that were parsed but yielded no claim outcome (e.g. an
// image-only certificate an earlier OCR pass missed), so ?outcomes=1&retry=1
// tries them again.
export async function resetConclusionParse() {
  await ensureSchema();
  const { rowCount } = await sql`
    UPDATE reexam_conclusions SET parsed = false
    WHERE parsed = true AND outcome_summary IS NULL AND cert_doc_id IS NOT NULL`;
  return rowCount;
}

// Re-pool ALL conclusions with a certificate so they re-parse — e.g. after
// improving the certificate parser. ?outcomes=1&reparse=1.
export async function resetAllConclusionParse() {
  await ensureSchema();
  const { rowCount } = await sql`
    UPDATE reexam_conclusions SET parsed = false
    WHERE cert_doc_id IS NOT NULL`;
  return rowCount;
}

// Read one proceeding's cached certificate text (for debugging the parser).
export async function getConclusionText(appNum) {
  await ensureSchema();
  const { rows } = await sql`SELECT cert_doc_id, cert_text, cert_ocr_engine, outcome_summary FROM reexam_conclusions WHERE application_number = ${appNum}`;
  return rows[0] || null;
}

// Re-pool certificates that were read but yielded no outcome (the OCR text was
// too garbled to parse): drop their cached text and mark unparsed so they get a
// fresh OCR pass — e.g. with the more accurate Engine 2. ?outcomes=1&reocr=1.
export async function clearUnparsedCertText() {
  await ensureSchema();
  const { rowCount } = await sql`
    UPDATE reexam_conclusions SET cert_text = NULL, parsed = false
    WHERE cert_doc_id IS NOT NULL AND parsed = true AND outcome_summary IS NULL`;
  return rowCount;
}

// Redo the whole conclusions table: clear the certificate side (and the rejected
// list) for every proceeding so detection re-finds RXCERTs and the parse step
// re-validates and re-parses them. NIRC dates are preserved for pendency tracking.
// ?conclusions=1&reset=1 (re-detect), then ?outcomes=1 (re-validate + parse).
export async function resetConclusionCerts() {
  await ensureSchema();
  const { rowCount } = await sql`
    UPDATE reexam_conclusions SET
      cert_doc_id = NULL, cert_date = NULL, cert_rejected_ids = NULL,
      outcome_summary = NULL, claims_confirmed = NULL, claims_cancelled = NULL,
      claims_amended = NULL, claims_new = NULL,
      parsed = false, checked_at = NULL`;
  return rowCount;
}

// ── Post-grant patent owner petitions (PET.OP) ─────────────────────
// Ordered reexams (RXREXO) not scanned for petitions within the last 7 days.
export async function getOrderedReexamsToCheckPetitions(limit) {
  await ensureSchema();
  // Ordered reexams not checked for a petition in the last 2 days, least-recently-
  // checked (and never-checked) first so coverage is fair across all proceedings —
  // ordering by application number instead would starve the higher control numbers
  // whenever the pool is larger than a run/day can cover.
  // Once a certificate has issued the proceeding is over — no new patent owner
  // petitions will be filed — so concluded proceedings are dropped from the
  // re-check rotation. They're only excluded AFTER at least one scan, so a
  // proceeding that concluded before it was ever scanned still gets one look.
  const { rows } = await sql`
    SELECT application_number, order_date FROM (
      SELECT DISTINCT ON (d.application_number) d.application_number, d.official_date AS order_date, s.checked_at
      FROM reexam_determinations d
      LEFT JOIN reexam_petition_scan s ON s.application_number = d.application_number
      LEFT JOIN reexam_conclusions c ON c.application_number = d.application_number
      WHERE d.determination_code = 'RXREXO'
        AND (s.checked_at IS NULL OR s.checked_at < now() - interval '2 days')
        AND NOT (c.cert_doc_id IS NOT NULL AND s.checked_at IS NOT NULL)
      ORDER BY d.application_number, d.official_date ASC NULLS LAST
    ) t
    ORDER BY t.checked_at ASC NULLS FIRST
    LIMIT ${limit}`;
  return rows;
}

// Active post-order petitions — a petition is recorded but no decision yet, so
// an opposition or decision could still be filed. Re-checked at most once a day
// (much more often than the 7-day discovery scan) to keep these rows current.
export async function getActivePetitionsToRefresh(limit) {
  await ensureSchema();
  const { rows } = await sql`
    SELECT p.application_number, p.order_date
    FROM reexam_post_petitions p
    LEFT JOIN reexam_petition_scan s ON s.application_number = p.application_number
    WHERE p.decision_doc_id IS NULL
      AND (s.checked_at IS NULL OR s.checked_at < now() - interval '1 day')
    ORDER BY s.checked_at ASC NULLS FIRST
    LIMIT ${limit}`;
  return rows;
}

export async function markPetitionScan(appNum) {
  await ensureSchema();
  await sql`
    INSERT INTO reexam_petition_scan (application_number, checked_at) VALUES (${appNum}, now())
    ON CONFLICT (application_number) DO UPDATE SET checked_at = now()`;
}

// Clear the petition scan cooldown so every ordered reexam is re-checked.
export async function resetPetitionScan() {
  await ensureSchema();
  const { rowCount } = await sql`DELETE FROM reexam_petition_scan`;
  return rowCount;
}

// Upsert a proceeding's post-order petition cluster (petition + opposition + decision).
export async function recordPostPetition(appNum, p) {
  await ensureSchema();
  await sql`
    INSERT INTO reexam_post_petitions
      (application_number, order_date, petition_doc_id, petition_date, petition_pages,
       opposition_doc_id, opposition_date, decision_doc_id, decision_date, decision_outcome, review_flag)
    VALUES (${appNum}, ${p.orderDate || null}, ${p.petitionDocId || null}, ${p.petitionDate || null}, ${p.petitionPages || null},
            ${p.oppositionDocId || null}, ${p.oppositionDate || null}, ${p.decisionDocId || null}, ${p.decisionDate || null}, ${p.decisionOutcome || null}, ${p.reviewFlag === undefined ? null : !!p.reviewFlag})
    ON CONFLICT (application_number) DO UPDATE SET
      order_date = COALESCE(EXCLUDED.order_date, reexam_post_petitions.order_date),
      petition_doc_id = EXCLUDED.petition_doc_id, petition_date = EXCLUDED.petition_date, petition_pages = EXCLUDED.petition_pages,
      opposition_doc_id = EXCLUDED.opposition_doc_id, opposition_date = EXCLUDED.opposition_date,
      decision_doc_id = EXCLUDED.decision_doc_id, decision_date = EXCLUDED.decision_date, decision_outcome = EXCLUDED.decision_outcome,
      review_flag = COALESCE(EXCLUDED.review_flag, reexam_post_petitions.review_flag),
      -- When the decision document changes (or first appears), reset OCR state so it re-OCRs.
      decision_325d         = CASE WHEN reexam_post_petitions.decision_doc_id IS DISTINCT FROM EXCLUDED.decision_doc_id THEN NULL ELSE reexam_post_petitions.decision_325d END,
      decision_ocr_status   = CASE WHEN reexam_post_petitions.decision_doc_id IS DISTINCT FROM EXCLUDED.decision_doc_id THEN NULL ELSE reexam_post_petitions.decision_ocr_status END,
      decision_ocr_job      = CASE WHEN reexam_post_petitions.decision_doc_id IS DISTINCT FROM EXCLUDED.decision_doc_id THEN NULL ELSE reexam_post_petitions.decision_ocr_job END,
      decision_pdf_blob_url = CASE WHEN reexam_post_petitions.decision_doc_id IS DISTINCT FROM EXCLUDED.decision_doc_id THEN NULL ELSE reexam_post_petitions.decision_pdf_blob_url END`;
  if (p.petitionDocId) await logDocEvent('post_petition', appNum, p.petitionDocId, { code: 'PET.OP', officialDate: p.petitionDate, label: 'Post-order patent owner petition' });
  if (p.oppositionDocId) await logDocEvent('post_opposition', appNum, p.oppositionDocId, { code: 'RXOPPPET', officialDate: p.oppositionDate, label: 'Requester opposition' });
  if (p.decisionDocId) await logDocEvent('post_decision', appNum, p.decisionDocId, { officialDate: p.decisionDate, label: 'Petition decision' + (p.decisionOutcome ? ' — ' + p.decisionOutcome : '') });
}

// ── Petition-decision OCR (OCR.space) state ────────────────────────
// Decisions with a document but no OCR started yet.
export async function getDecisionsToStartOcr(limit) {
  await ensureSchema();
  const { rows } = await sql`
    SELECT application_number, decision_doc_id
    FROM reexam_post_petitions
    WHERE decision_doc_id IS NOT NULL AND decision_ocr_status IS NULL
      AND petition_325d = true
    ORDER BY found_at ASC LIMIT ${limit}`;
  return rows;
}

export async function setDecisionOcrDone(appNum, is325d, blobUrl) {
  await ensureSchema();
  await sql`UPDATE reexam_post_petitions
            SET decision_325d = ${is325d}, decision_pdf_blob_url = ${blobUrl || null}, decision_ocr_status = 'done'
            WHERE application_number = ${appNum}`;
}

export async function setDecisionOcrFailed(appNum) {
  await ensureSchema();
  await sql`UPDATE reexam_post_petitions SET decision_ocr_status = 'failed' WHERE application_number = ${appNum}`;
}

// Decisions still awaiting OCR (not yet attempted).
export async function countDecisionsOcrPending() {
  await ensureSchema();
  const { rows } = await sql`
    SELECT count(*)::int AS n FROM reexam_post_petitions
    WHERE decision_doc_id IS NOT NULL AND decision_ocr_status IS NULL
      AND petition_325d = true`;
  return rows[0] ? rows[0].n : 0;
}

// Re-pool failed OCR attempts so they're retried.
export async function resetFailedDecisionOcr() {
  await ensureSchema();
  const { rowCount } = await sql`UPDATE reexam_post_petitions SET decision_ocr_status = NULL WHERE decision_ocr_status = 'failed'`;
  return rowCount;
}

// ── Petition §325(d) detection (text-first, OCR fallback) ──────────
// status: NULL = untouched, 'pending_ocr' = text had no layer (needs OCR via the
// backfill), 'done' = resolved, 'failed' = transient error (re-pool with retry).
// Cron pool: never-touched petitions, for the fast text-only pass.
export async function getPetitionsToCheck325d(limit) {
  await ensureSchema();
  const { rows } = await sql`
    SELECT application_number, petition_doc_id
    FROM reexam_post_petitions
    WHERE petition_doc_id IS NOT NULL AND petition_325d_status IS NULL
    ORDER BY found_at ASC LIMIT ${limit}`;
  return rows;
}
// Backfill pool: never-touched OR flagged as needing OCR.
export async function getPetitionsToOcr325d(limit) {
  await ensureSchema();
  const { rows } = await sql`
    SELECT application_number, petition_doc_id
    FROM reexam_post_petitions
    WHERE petition_doc_id IS NOT NULL AND (petition_325d_status IS NULL OR petition_325d_status = 'pending_ocr')
    ORDER BY found_at ASC LIMIT ${limit}`;
  return rows;
}
// Image-only petitions awaiting OCR (text pass found no text layer).
export async function getPetitionsPendingOcr(limit) {
  await ensureSchema();
  const { rows } = await sql`
    SELECT application_number, petition_doc_id
    FROM reexam_post_petitions
    WHERE petition_doc_id IS NOT NULL AND petition_325d_status = 'pending_ocr'
    ORDER BY found_at ASC LIMIT ${limit}`;
  return rows;
}
export async function setPetition325dDone(appNum, is325d) {
  await ensureSchema();
  await sql`UPDATE reexam_post_petitions
            SET petition_325d = ${is325d}, petition_325d_status = 'done'
            WHERE application_number = ${appNum}`;
}
export async function setPetition325dPendingOcr(appNum) {
  await ensureSchema();
  await sql`UPDATE reexam_post_petitions SET petition_325d_status = 'pending_ocr' WHERE application_number = ${appNum}`;
}
export async function setPetition325dFailed(appNum) {
  await ensureSchema();
  await sql`UPDATE reexam_post_petitions SET petition_325d_status = 'failed' WHERE application_number = ${appNum}`;
}
// Outstanding work for the OCR backfill (untouched + pending_ocr).
export async function countPetitions325dPending() {
  await ensureSchema();
  const { rows } = await sql`
    SELECT count(*)::int AS n FROM reexam_post_petitions
    WHERE petition_doc_id IS NOT NULL AND (petition_325d_status IS NULL OR petition_325d_status = 'pending_ocr')`;
  return rows[0] ? rows[0].n : 0;
}
export async function resetFailedPetition325d() {
  await ensureSchema();
  const { rowCount } = await sql`UPDATE reexam_post_petitions SET petition_325d_status = NULL WHERE petition_325d_status = 'failed'`;
  return rowCount;
}
// Re-pool petitions previously resolved as NOT citing 325(d) (status 'done',
// petition_325d = false) so they're re-evaluated text-first then OCR — recovers
// false negatives (e.g. image-only petitions an earlier OCR pass missed). Only
// the status is cleared; petition_325d stays false until re-resolved, so these
// stay hidden from the page during the re-check (no flicker).
export async function resetDonePetition325dFalse() {
  await ensureSchema();
  const { rowCount } = await sql`
    UPDATE reexam_post_petitions SET petition_325d_status = NULL
    WHERE petition_325d_status = 'done' AND petition_325d = false`;
  return rowCount;
}

// ── Office action timing (RXR.NF / RXR.F) ──────────────────────────
// Ordered reexams (since the cutoff) not yet checked, or still missing a final
// action and not checked in the last 7 days.
export async function getOrderedReexamsToCheckActions(limit) {
  await ensureSchema();
  // Ordered reexams without a final action, not checked in the last day, least-
  // recently-checked (and never-checked) first so coverage is fair — ordering by
  // application number would starve the higher control numbers when the pool is
  // larger than a run/day can cover.
  const { rows } = await sql`
    SELECT application_number, order_date FROM (
      SELECT DISTINCT ON (det.application_number) det.application_number, det.official_date AS order_date, a.checked_at
      FROM reexam_determinations det
      LEFT JOIN reexam_actions a ON a.application_number = det.application_number
      WHERE det.determination_code IN ('RXREXO', 'RX.SE.ORDER') AND det.official_date >= '2025-01-01'
        AND (a.application_number IS NULL OR (a.finl_date IS NULL AND (a.checked_at IS NULL OR a.checked_at < now() - interval '1 day')))
      ORDER BY det.application_number, det.official_date ASC NULLS LAST
    ) t
    ORDER BY t.checked_at ASC NULLS FIRST
    LIMIT ${limit}`;
  return rows;
}

export async function recordActions(appNum, a) {
  await ensureSchema();
  await sql`
    INSERT INTO reexam_actions (application_number, order_date, nonf_date, nonf_doc_id, finl_date, finl_doc_id, action_count, review_flag, checked_at)
    VALUES (${appNum}, ${a.orderDate || null}, ${a.nonfDate || null}, ${a.nonfDocId || null}, ${a.finlDate || null}, ${a.finlDocId || null}, ${a.actionCount == null ? null : a.actionCount}, ${a.reviewFlag === undefined ? null : !!a.reviewFlag}, now())
    ON CONFLICT (application_number) DO UPDATE SET
      order_date   = COALESCE(EXCLUDED.order_date, reexam_actions.order_date),
      nonf_date    = COALESCE(EXCLUDED.nonf_date, reexam_actions.nonf_date),
      nonf_doc_id  = COALESCE(EXCLUDED.nonf_doc_id, reexam_actions.nonf_doc_id),
      finl_date    = COALESCE(EXCLUDED.finl_date, reexam_actions.finl_date),
      finl_doc_id  = COALESCE(EXCLUDED.finl_doc_id, reexam_actions.finl_doc_id),
      action_count = COALESCE(EXCLUDED.action_count, reexam_actions.action_count),
      review_flag  = COALESCE(EXCLUDED.review_flag, reexam_actions.review_flag),
      checked_at   = now()`;
  if (a.nonfDocId) await logDocEvent('action_nonf', appNum, a.nonfDocId, { code: 'RXR.NF', officialDate: a.nonfDate, label: 'First non-final office action' });
  if (a.finlDocId) await logDocEvent('action_finl', appNum, a.finlDocId, { code: 'RXR.F', officialDate: a.finlDate, label: 'Final office action' });
}

// Clear all recorded office action timing so every ordered reexam is re-scanned
// (e.g., to backfill newly-added document-id columns).
export async function resetReexamActions() {
  await ensureSchema();
  const { rowCount } = await sql`DELETE FROM reexam_actions`;
  return rowCount;
}

export async function countActionsToCheck() {
  await ensureSchema();
  const { rows } = await sql`
    SELECT count(*)::int AS n FROM (
      SELECT DISTINCT det.application_number
      FROM reexam_determinations det
      LEFT JOIN reexam_actions a ON a.application_number = det.application_number
      WHERE det.determination_code IN ('RXREXO', 'RX.SE.ORDER') AND det.official_date >= '2025-01-01'
        AND a.application_number IS NULL
    ) t`;
  return rows[0] ? rows[0].n : 0;
}

// Office action timing rows for the dedicated page, with examiner/art-unit context.
export async function listReexamActions() {
  await ensureSchema();
  const { rows } = await sql`
    SELECT a.application_number, a.order_date, a.nonf_date, a.nonf_doc_id, a.finl_date, a.finl_doc_id, a.action_count, a.review_flag,
           d.examiner_name, d.group_art_unit, tc.tech_center,
           w.filing_date, c.nirc_date, c.cert_date
    FROM reexam_actions a
    LEFT JOIN (
      SELECT DISTINCT ON (application_number) application_number, examiner_name, group_art_unit
      FROM reexam_determinations WHERE determination_code IN ('RXREXO', 'RX.SE.ORDER')
      ORDER BY application_number, official_date ASC NULLS LAST
    ) d ON d.application_number = a.application_number
    LEFT JOIN reexam_tech_center tc ON tc.application_number = a.application_number
    LEFT JOIN reexam_watch w ON w.application_number = a.application_number
    LEFT JOIN reexam_conclusions c ON c.application_number = a.application_number
    WHERE a.order_date >= '2025-01-01'
    ORDER BY a.order_date DESC NULLS LAST, a.application_number DESC`;
  return rows;
}

// Post-order petitions for the dedicated page, with examiner/art-unit context.
export async function listPostOrderPetitions() {
  await ensureSchema();
  const { rows } = await sql`
    SELECT p.application_number, p.order_date,
           p.petition_doc_id, p.petition_date,
           p.opposition_doc_id, p.opposition_date,
           p.decision_doc_id, p.decision_date, p.decision_outcome, p.decision_325d, p.decision_pdf_blob_url, p.review_flag,
           d.examiner_name, d.group_art_unit,
           a.nonf_date, a.nonf_doc_id
    FROM reexam_post_petitions p
    LEFT JOIN (
      SELECT DISTINCT ON (application_number) application_number, examiner_name, group_art_unit
      FROM reexam_determinations WHERE determination_code = 'RXREXO'
      ORDER BY application_number, official_date ASC NULLS LAST
    ) d ON d.application_number = p.application_number
    LEFT JOIN reexam_actions a ON a.application_number = p.application_number
    WHERE p.order_date >= '2025-01-01'
      -- Show only proceedings whose patent owner petition cites § 325(d). Drop
      -- those determined NOT to (false); keep pending (not yet checked = NULL).
      AND p.petition_325d IS DISTINCT FROM false
      -- And once a petition decision has been checked, it must also cite § 325(d):
      -- drop decisions determined NOT to (false); keep pending / no-decision (NULL).
      AND p.decision_325d IS DISTINCT FROM false
    ORDER BY p.petition_date DESC NULLS LAST, p.application_number DESC`;
  return rows;
}

// ── Public daily-notification subscribers ──────────────────────────
// Add a subscriber (idempotent). Returns { email, token, existed }.
export async function addReexamSubscriber(email) {
  await ensureSchema();
  const e = String(email || '').trim().toLowerCase();
  const token = randomUUID().replace(/-/g, '');
  const { rows } = await sql`
    INSERT INTO reexam_subscribers (email, token) VALUES (${e}, ${token})
    ON CONFLICT (email) DO NOTHING
    RETURNING email, token`;
  if (rows.length) return { email: e, token: rows[0].token, existed: false };
  const ex = await sql`SELECT email, token FROM reexam_subscribers WHERE email = ${e}`;
  return { email: e, token: ex.rows[0] ? ex.rows[0].token : token, existed: true };
}

// Remove a subscriber by their unsubscribe token. Returns the email, or null.
export async function removeReexamSubscriberByToken(token) {
  await ensureSchema();
  const { rows } = await sql`DELETE FROM reexam_subscribers WHERE token = ${String(token || '')} RETURNING email`;
  return rows.length ? rows[0].email : null;
}

export async function getReexamSubscriber(email) {
  await ensureSchema();
  const e = String(email || '').trim().toLowerCase();
  const { rows } = await sql`SELECT email, token FROM reexam_subscribers WHERE email = ${e}`;
  return rows[0] || null;
}

export async function listReexamSubscribers() {
  await ensureSchema();
  const { rows } = await sql`SELECT email, token FROM reexam_subscribers ORDER BY created_at`;
  return rows;
}

// Determinations whose official_date falls on a given YYYY-MM-DD (prefix match,
// tolerant of any time component stored alongside the date).
export async function listDeterminationsByOfficialDate(date) {
  await ensureSchema();
  const prefix = String(date) + '%';
  const { rows } = await sql`
    SELECT application_number, document_identifier, determination_type, official_date,
           group_art_unit, examiner_name
    FROM reexam_determinations
    WHERE official_date LIKE ${prefix}
    ORDER BY determination_type, application_number`;
  return rows;
}

// Idempotency for the daily subscriber digest.
export async function getSubDigestDate() {
  await ensureSchema();
  const { rows } = await sql`SELECT last_sub_digest_date FROM reexam_state WHERE id = 1`;
  return rows[0] ? rows[0].last_sub_digest_date : null;
}

export async function setSubDigestDate(date) {
  await sql`UPDATE reexam_state SET last_sub_digest_date = ${String(date)} WHERE id = 1`;
}

// ── Owner daily digest: ledger of newly-detected relevant documents ──
// Log a document the first time we detect it (re-detection is a no-op). Wrapped
// so a logging hiccup never breaks the detection path that calls it.
export async function logDocEvent(category, appNum, docId, info = {}) {
  if (!appNum || !docId) return;
  try {
    await ensureSchema();
    await sql`
      INSERT INTO reexam_doc_events (category, application_number, document_id, doc_code, official_date, label)
      VALUES (${category}, ${appNum}, ${docId}, ${info.code || null}, ${info.officialDate || null}, ${info.label || null})
      ON CONFLICT (category, application_number, document_id) DO NOTHING`;
  } catch { /* best-effort ledger */ }
}

// Logged documents whose official USPTO date falls on the given day (YYYY-MM-DD),
// for the owner digest. Post-order petition papers are limited to proceedings that
// still display on the § 325(d) page (petition cites 325(d); decision cites it or none yet).
export async function getDocEventsByOfficialDate(date) {
  await ensureSchema();
  const { rows } = await sql`
    SELECT e.category, e.application_number, e.document_id, e.doc_code, e.official_date, e.label, e.discovered_at
    FROM reexam_doc_events e
    LEFT JOIN reexam_post_petitions p ON p.application_number = e.application_number
    WHERE LEFT(e.official_date, 10) = ${String(date)}
      AND (e.category NOT LIKE 'post_%'
           OR (p.petition_325d IS DISTINCT FROM false AND p.decision_325d IS DISTINCT FROM false))
    ORDER BY e.category, e.application_number`;
  return rows;
}

export async function getOwnerDigestDate() {
  await ensureSchema();
  const { rows } = await sql`SELECT owner_digest_date FROM reexam_state WHERE id = 1`;
  return rows[0] ? rows[0].owner_digest_date : null;
}

export async function setOwnerDigestDate(date) {
  await sql`UPDATE reexam_state SET owner_digest_date = ${String(date)} WHERE id = 1`;
}

// Pre-order coverage denominators, precomputed daily by the cron (see
// fetchPreorderCoverage). Returns nulls until the cron first populates them.
export async function getPreorderCounts() {
  await ensureSchema();
  const { rows } = await sql`SELECT preorder_total_filed, preorder_deadline_passed, preorder_counts_at FROM reexam_state WHERE id = 1`;
  return rows[0] || { preorder_total_filed: null, preorder_deadline_passed: null, preorder_counts_at: null };
}

export async function setPreorderCounts(totalFiled, deadlinePassed) {
  await ensureSchema();
  await sql`UPDATE reexam_state SET
      preorder_total_filed = ${totalFiled == null ? null : Number(totalFiled)},
      preorder_deadline_passed = ${deadlinePassed == null ? null : Number(deadlinePassed)},
      preorder_counts_at = now()
    WHERE id = 1`;
}

// Counts for right-sizing the scan: total tracked, still-to-scan, and determined.
export async function reexamCounts() {
  await ensureSchema();
  const { rows } = await sql`
    SELECT count(*)::int AS total,
           count(*) FILTER (WHERE determined = false)::int AS remaining,
           count(*) FILTER (WHERE determined = true)::int  AS determined
    FROM reexam_watch`;
  return rows[0] || { total: 0, remaining: 0, determined: 0 };
}

// One-shot operational snapshot for the admin /status page: how many proceedings
// are currently DUE for each kind of check (mirrors each pool's cooldown logic),
// plus the last enumeration/digest timestamps. One DB round trip.
export async function getStatusSnapshot() {
  await ensureSchema();
  const { rows } = await sql`
    SELECT
      (SELECT count(*)::int FROM reexam_watch) AS watch_total,
      (SELECT count(*)::int FROM reexam_watch WHERE determined = false) AS undetermined,
      (SELECT count(*)::int FROM reexam_watch WHERE determined = false AND last_scanned_at IS NULL) AS never_scanned,
      (SELECT min(last_scanned_at) FROM reexam_watch WHERE determined = false) AS oldest_scan,
      (SELECT count(DISTINCT det.application_number)::int
         FROM reexam_determinations det
         LEFT JOIN reexam_actions a ON a.application_number = det.application_number
         WHERE det.determination_code IN ('RXREXO', 'RX.SE.ORDER') AND det.official_date >= '2025-01-01'
           AND (a.application_number IS NULL OR (a.finl_date IS NULL AND (a.checked_at IS NULL OR a.checked_at < now() - interval '1 day')))) AS actions_due,
      (SELECT count(DISTINCT d.application_number)::int
         FROM reexam_determinations d
         LEFT JOIN reexam_petition_scan s ON s.application_number = d.application_number
         LEFT JOIN reexam_conclusions c ON c.application_number = d.application_number
         WHERE d.determination_code = 'RXREXO'
           AND (s.checked_at IS NULL OR s.checked_at < now() - interval '2 days')
           AND NOT (c.cert_doc_id IS NOT NULL AND s.checked_at IS NOT NULL)) AS petitions_due,
      (SELECT count(*)::int
         FROM reexam_post_petitions p
         LEFT JOIN reexam_petition_scan s ON s.application_number = p.application_number
         WHERE p.decision_doc_id IS NULL
           AND (s.checked_at IS NULL OR s.checked_at < now() - interval '1 day')) AS active_petitions_due,
      (SELECT count(DISTINCT d.application_number)::int
         FROM reexam_determinations d
         LEFT JOIN reexam_conclusions c ON c.application_number = d.application_number
         WHERE d.determination_code IN ('RXREXO', 'RX.SE.ORDER') AND c.cert_doc_id IS NULL
           AND (c.checked_at IS NULL OR c.checked_at < now() - interval '2 days')) AS conclusions_due,
      (SELECT count(*)::int FROM reexam_post_petitions
         WHERE petition_doc_id IS NOT NULL AND (petition_325d_status IS NULL OR petition_325d_status = 'pending_ocr')) AS petition325d_pending,
      (SELECT count(*)::int FROM (SELECT DISTINCT application_number FROM reexam_determinations) d
         LEFT JOIN reexam_tech_center tc ON tc.application_number = d.application_number
         WHERE tc.tech_center IS NULL AND (tc.checked_at IS NULL OR tc.checked_at < now() - interval '14 days')) AS techcenter_due,
      (SELECT count(*)::int FROM reexam_watch
         WHERE filing_date >= ${PREORDER_CUTOFF} AND (preorder_checked_at IS NULL OR preorder_checked_at < now() - interval '2 days')) AS preorder_due,
      (SELECT count(*)::int FROM reexam_conclusions WHERE parsed = false AND cert_doc_id IS NOT NULL) AS outcomes_to_parse,
      (SELECT count(*)::int FROM reexam_conclusions WHERE cert_doc_id IS NOT NULL AND cert_ocr_engine IS DISTINCT FROM '2') AS engine2_pending,
      (SELECT count(*)::int FROM watched_applications) AS watchlist_count,
      (SELECT last_enumerated_at FROM reexam_state WHERE id = 1) AS last_enumerated_at,
      (SELECT last_digest_at FROM reexam_state WHERE id = 1) AS last_determination_digest_at,
      (SELECT owner_digest_date FROM reexam_state WHERE id = 1) AS owner_digest_date,
      (SELECT last_sub_digest_date FROM reexam_state WHERE id = 1) AS subscriber_digest_date,
      (SELECT enum_reported FROM reexam_state WHERE id = 1) AS enum_reported,
      (SELECT enum_fetched FROM reexam_state WHERE id = 1) AS enum_fetched,
      (SELECT enum_db_count FROM reexam_state WHERE id = 1) AS enum_db_count,
      (SELECT enum_window_from FROM reexam_state WHERE id = 1) AS enum_window_from,
      (SELECT enum_at FROM reexam_state WHERE id = 1) AS enum_at,
      (SELECT enum_complete FROM reexam_state WHERE id = 1) AS enum_complete,
      (SELECT max(official_date) FROM reexam_determinations) AS latest_determination`;
  return rows[0] || {};
}

export async function listRecentDeterminations(limit) {
  await ensureSchema();
  // filing_date is joined from reexam_watch (no extra API calls) for pendency.
  //
  // PROCEEDING GRAIN (DA-1): multiple determination documents can exist for one
  // control number (duplicate orders; a denial later superseded by an order).
  // Return ONE operative row per proceeding — the latest-dated determination
  // document — plus doc_count so callers can flag multi-document proceedings.
  // The dedupe happens in a subquery BEFORE any LIMIT so a page cap can't
  // truncate the population mid-proceeding. All document rows remain stored as
  // evidence in reexam_determinations.
  if (limit && limit > 0) {
    const { rows } = await sql`
      SELECT * FROM (
        SELECT DISTINCT ON (d.application_number)
               d.application_number, d.document_identifier, d.determination_type, d.official_date,
               d.group_art_unit, d.examiner_name, d.requester_type, d.found_at, w.filing_date,
               c.cert_doc_id, c.cert_date, c.nirc_doc_id, c.nirc_date, c.outcome_summary,
               tc.tech_center, tc.underlying_patent,
               count(*) OVER (PARTITION BY d.application_number)::int AS doc_count
        FROM reexam_determinations d
        LEFT JOIN reexam_watch w ON w.application_number = d.application_number
        LEFT JOIN reexam_conclusions c ON c.application_number = d.application_number
        LEFT JOIN reexam_tech_center tc ON tc.application_number = d.application_number
        ORDER BY d.application_number, d.official_date DESC NULLS LAST, d.document_identifier DESC
      ) t
      ORDER BY t.official_date DESC NULLS LAST, t.found_at DESC
      LIMIT ${limit}`;
    return rows;
  }
  const { rows } = await sql`
    SELECT * FROM (
      SELECT DISTINCT ON (d.application_number)
             d.application_number, d.document_identifier, d.determination_type, d.official_date,
             d.group_art_unit, d.examiner_name, d.requester_type, d.found_at, w.filing_date,
             c.cert_doc_id, c.cert_date, c.nirc_doc_id, c.nirc_date, c.outcome_summary,
             c.claims_confirmed, c.claims_cancelled, c.claims_amended, c.claims_new, c.cert_ocr_engine,
             tc.tech_center, tc.underlying_patent,
             count(*) OVER (PARTITION BY d.application_number)::int AS doc_count
      FROM reexam_determinations d
      LEFT JOIN reexam_watch w ON w.application_number = d.application_number
      LEFT JOIN reexam_conclusions c ON c.application_number = d.application_number
      LEFT JOIN reexam_tech_center tc ON tc.application_number = d.application_number
      ORDER BY d.application_number, d.official_date DESC NULLS LAST, d.document_identifier DESC
    ) t
    ORDER BY t.official_date DESC NULLS LAST, t.found_at DESC`;
  return rows;
}

export async function listWatched() {
  await ensureSchema();
  // latest_date is the most recent document official_date already stored for the
  // application (no USPTO call needed — it comes from seen_documents).
  const { rows } = await sql`
    SELECT w.application_number, w.label, w.recipients, w.created_at,
           (SELECT MAX(s.official_date)
              FROM seen_documents s
             WHERE s.application_number = w.application_number) AS latest_date
    FROM watched_applications w
    ORDER BY w.created_at DESC`;
  return rows;
}

// Merge two recipient strings into a deduplicated (case-insensitive) list.
function mergeRecipients(a, b) {
  const parse = (s) => String(s || '').split(/[,;]/).map((x) => x.trim()).filter(Boolean);
  const out = [];
  const seen = new Set();
  for (const e of [...parse(a), ...parse(b)]) {
    const k = e.toLowerCase();
    if (!seen.has(k)) { seen.add(k); out.push(e); }
  }
  return out.length ? out.join(', ') : null;
}

// Add an application to the watchlist. If it is ALREADY tracked, merge the new
// recipient email(s) into the existing notify list (no overwrite) and keep the
// existing label (only set the label if there wasn't one). Returns { existed }.
export async function addWatched(appNum, label, recipients) {
  await ensureSchema();
  const { rows } = await sql`
    SELECT label, recipients FROM watched_applications WHERE application_number = ${appNum}`;

  if (rows.length) {
    const existing = rows[0];
    const mergedRecipients = mergeRecipients(existing.recipients, recipients);
    const keptLabel = existing.label || label || null;
    await sql`UPDATE watched_applications
                 SET label = ${keptLabel}, recipients = ${mergedRecipients}
               WHERE application_number = ${appNum}`;
    return { existed: true };
  }

  await sql`INSERT INTO watched_applications (application_number, label, recipients)
            VALUES (${appNum}, ${label || null}, ${recipients || null})`;
  return { existed: false };
}

export async function setRecipients(appNum, recipients) {
  await ensureSchema();
  await sql`UPDATE watched_applications SET recipients = ${recipients || null}
            WHERE application_number = ${appNum}`;
}

// Remove an email (case-insensitive) from EVERY tracked application's recipient
// list — the "unsubscribe from all tracked proceedings" action. Returns how many
// applications it was removed from.
export async function removeRecipientFromAllWatched(email) {
  await ensureSchema();
  const target = String(email || '').trim().toLowerCase();
  if (!target) return 0;
  const { rows } = await sql`SELECT application_number, recipients FROM watched_applications WHERE recipients IS NOT NULL`;
  let removed = 0;
  for (const r of rows) {
    const list = String(r.recipients || '').split(/[,;]/).map((x) => x.trim()).filter(Boolean);
    const kept = list.filter((e) => e.toLowerCase() !== target);
    if (kept.length !== list.length) {
      await sql`UPDATE watched_applications SET recipients = ${kept.length ? kept.join(', ') : null} WHERE application_number = ${r.application_number}`;
      removed++;
    }
  }
  return removed;
}

export async function removeWatched(appNum) {
  await ensureSchema();
  await sql`DELETE FROM seen_documents     WHERE application_number = ${appNum}`;
  await sql`DELETE FROM watched_applications WHERE application_number = ${appNum}`;
}

export async function listFindings() {
  await ensureSchema();
  const { rows } = await sql`
    SELECT s.application_number, w.label, s.document_identifier, s.document_code,
           s.description, s.official_date, s.direction, s.formats, s.first_seen_at
    FROM seen_documents s
    LEFT JOIN watched_applications w ON w.application_number = s.application_number
    WHERE s.is_new = true
    ORDER BY s.official_date DESC NULLS LAST, s.first_seen_at DESC`;
  return rows;
}

export async function acknowledgeFindings() {
  await ensureSchema();
  await sql`UPDATE seen_documents SET is_new = false WHERE is_new = true`;
}

export async function acknowledgeFinding(appNum, documentId) {
  await ensureSchema();
  await sql`UPDATE seen_documents SET is_new = false
            WHERE application_number = ${appNum} AND document_identifier = ${documentId}`;
}

// Sync one application's documents into the DB.
// markNew = false for the initial baseline (so the docs that already exist when
// you start tracking are NOT flagged as "new"); the cron passes markNew = true.
// All documents are inserted in a SINGLE batched query (ON CONFLICT DO NOTHING),
// and RETURNING tells us which rows were newly inserted.
export async function syncApplication(appNum, markNew) {
  await ensureSchema();
  const docs = await fetchDocuments(appNum);
  if (!docs.length) return { total: 0, added: 0, addedDocs: [] };

  // Only treat a document as a NEW filing (flag + email) if its USPTO date is
  // regardless of its official date (DA-13): USPTO often posts documents to the
  // wrapper days late, and those late-posted filings previously never alerted.
  // "New" now means first seen by us during a markNew sync.

  const COLS = 8;
  const valueGroups = [];
  const params = [];
  docs.forEach((d, i) => {
    const b = i * COLS;
    valueGroups.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8})`);
    params.push(appNum, d.documentIdentifier, d.documentCode, d.description,
                d.officialDate, d.direction, d.formats.join(','), !!markNew);
  });

  const text =
    `INSERT INTO seen_documents
       (application_number, document_identifier, document_code, description,
        official_date, direction, formats, is_new)
     VALUES ${valueGroups.join(',')}
     ON CONFLICT (application_number, document_identifier) DO NOTHING
     RETURNING document_identifier`;

  const { rows } = await sql.query(text, params);
  const addedIds = new Set(rows.map((r) => r.document_identifier));
  // Every newly-seen document is surfaced/notified (DA-13) — including ones
  // USPTO posted late with an older official date.
  const addedDocs = docs
    .filter((d) => addedIds.has(d.documentIdentifier))
    .map((d) => ({ applicationNumber: appNum, ...d, formats: d.formats }));

  return { total: docs.length, added: addedDocs.length, addedDocs };
}
