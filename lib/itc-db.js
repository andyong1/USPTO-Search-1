// USITC Section 337 tracker — Postgres store (Neon via @vercel/postgres).
//
// This module is the DURABLE, queryable source of truth for the ITC 337 tracker.
// It is written ONLY by the local scripts (edis-fetch.mjs → edis-upload.mjs); no
// Vercel serverless function imports it, so it adds neither to the Hobby
// 12-function count nor to any function bundle. The public /itc page is served
// from a static Vercel Blob projection built by edis-upload.mjs — Neon is not in
// the read path (see MEMORY / itc.html). Future phases (OCR text, AI summaries,
// the CourtListener cross-venue join) will read from these tables.
//
// Kept SEPARATE from lib/db.js on purpose: that file is the large USPTO/PTAB/reexam
// schema, and this feature is independent. The schema is self-migrating via
// ensureItcSchema() with its own version stamp in the shared ptab_kv table.

import { sql } from '@vercel/postgres';

let ready = false;
let readyPromise = null;

// Bump WHENEVER the DDL below changes, so an existing DB re-runs the (idempotent)
// migration. The gate skips the DDL round-trips when the DB is already current.
const ITC_SCHEMA_VERSION = '2026-07-27.1';

export async function ensureItcSchema() {
  if (ready) return;
  if (!readyPromise) readyPromise = ensureOnce().then(() => { ready = true; }).finally(() => { readyPromise = null; });
  return readyPromise;
}

async function ensureOnce() {
  try {
    const { rows } = await sql`SELECT v FROM ptab_kv WHERE k = 'itc_schema_version' LIMIT 1`;
    if (rows[0] && rows[0].v === ITC_SCHEMA_VERSION) return;
  } catch { /* ptab_kv may not exist yet on a fresh DB — fall through to migrate */ }
  await migrate();
  try {
    await sql`INSERT INTO ptab_kv (k, v, updated_at) VALUES ('itc_schema_version', ${ITC_SCHEMA_VERSION}, now())
              ON CONFLICT (k) DO UPDATE SET v = ${ITC_SCHEMA_VERSION}, updated_at = now()`;
  } catch { /* stamp is best-effort; a failed stamp just re-migrates next run */ }
}

async function migrate() {
  // ptab_kv is created by lib/db.js on the live site, but this module can run
  // against a DB where lib/db.js migrations haven't executed (e.g. a fresh local
  // DB), so create it here too — the definition matches lib/db.js exactly.
  await sql`CREATE TABLE IF NOT EXISTS ptab_kv (k text PRIMARY KEY, v text, updated_at timestamptz DEFAULT now())`;

  // ── One row per (investigation number, phase) ──────────────────────
  // EDIS returns a SEPARATE investigation record per phase (Violation, Remand,
  // Enforcement, Advisory, Modification, …), each with its own docket number, so
  // the natural key is (number, phase) — number alone is NOT unique.
  await sql`CREATE TABLE IF NOT EXISTS itc_investigation (
    investigation_number text NOT NULL,
    investigation_phase  text NOT NULL,
    public_number        text,              -- "337-TA-1000", parsed from the title
    title                text,
    inv_type             text,              -- always "Sec 337" for this tracker
    status               text,              -- Active | Inactive
    docket_number        text,
    -- Derived from this phase's documents (edis-upload.mjs; heuristic, Phase 1):
    institution_date     text,              -- earliest institution/NOI document date
    last_doc_date        text,              -- most recent document received date
    doc_count            int,
    public_doc_count     int,
    outcome              text,              -- see classifyOutcome() in edis-upload.mjs
    remedy               text,              -- LEO | GEO | CDO | null
    review_flag          boolean,           -- outcome was ambiguous — verify
    participants         jsonb,             -- distinct onBehalfOf parties (unroled, Phase 1)
    top_firms            jsonb,             -- [{firm, count}] excluding the Commission
    derived_v            int DEFAULT 0,     -- derivation logic version that filled the above
    first_seen           timestamptz NOT NULL DEFAULT now(),
    last_seen            timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (investigation_number, investigation_phase)
  )`;
  await sql`CREATE INDEX IF NOT EXISTS itc_investigation_num_idx ON itc_investigation (investigation_number)`;
  await sql`CREATE INDEX IF NOT EXISTS itc_investigation_status_idx ON itc_investigation (status)`;

  // ── One row per EDIS document (the raw filing feed) ────────────────
  // The full metadata stream. Powers the derivations above, a "recent filings"
  // view, and firm/party aggregation. Confidential documents appear here as
  // METADATA only (security_level = 'Confidential'); their contents are not
  // fetched. This is the substrate the Phase 2 OCR/AI passes will read from.
  await sql`CREATE TABLE IF NOT EXISTS itc_document (
    id                   text PRIMARY KEY,  -- EDIS document <id>
    investigation_number text NOT NULL,
    investigation_phase  text,
    document_type        text,
    document_title       text,
    security_level       text,              -- Public | Confidential | ...
    firm_organization    text,
    filed_by             text,
    on_behalf_of         text,
    document_date        text,              -- YYYY-MM-DD (normalized from EDIS)
    received_date        text,              -- YYYY-MM-DD (officialReceivedDate)
    attachment_list_uri  text,
    modified_date        text,
    found_at             timestamptz NOT NULL DEFAULT now()
  )`;
  await sql`CREATE INDEX IF NOT EXISTS itc_document_inv_idx ON itc_document (investigation_number)`;
  await sql`CREATE INDEX IF NOT EXISTS itc_document_received_idx ON itc_document (received_date)`;

  // Crawl bookkeeping: one row per crawl target so a run is resumable and the
  // page can show "last updated".
  await sql`CREATE TABLE IF NOT EXISTS itc_scan_log (
    scanned_at   timestamptz NOT NULL DEFAULT now(),
    mode         text,                      -- 'investigations' | 'documents'
    inv_count    int,
    doc_count    int,
    note         text
  )`;
}

// ── Upserts (called by edis-upload.mjs) ────────────────────────────────

// Upsert the investigation CATALOG fields (from the investigation list crawl).
// Leaves the derived columns untouched — setInvestigationDerived fills those.
export async function upsertInvestigation(inv) {
  await ensureItcSchema();
  await sql`
    INSERT INTO itc_investigation
      (investigation_number, investigation_phase, public_number, title, inv_type, status, docket_number, last_seen)
    VALUES (${inv.number}, ${inv.phase}, ${inv.publicNumber || null}, ${inv.title || null},
            ${inv.type || null}, ${inv.status || null}, ${inv.docket || null}, now())
    ON CONFLICT (investigation_number, investigation_phase) DO UPDATE SET
      public_number = COALESCE(EXCLUDED.public_number, itc_investigation.public_number),
      title         = COALESCE(EXCLUDED.title, itc_investigation.title),
      inv_type      = COALESCE(EXCLUDED.inv_type, itc_investigation.inv_type),
      status        = COALESCE(EXCLUDED.status, itc_investigation.status),
      docket_number = COALESCE(EXCLUDED.docket_number, itc_investigation.docket_number),
      last_seen     = now()`;
}

// Persist the heuristic derivations (institution date, outcome, remedy, firms …)
// for one (number, phase). Called after that phase's documents are ingested.
export async function setInvestigationDerived(number, phase, d, derivedV) {
  await sql`
    UPDATE itc_investigation SET
      institution_date = ${d.institutionDate || null},
      last_doc_date    = ${d.lastDocDate || null},
      doc_count        = ${d.docCount ?? null},
      public_doc_count = ${d.publicDocCount ?? null},
      outcome          = ${d.outcome || null},
      remedy           = ${d.remedy || null},
      review_flag      = ${d.reviewFlag ?? null},
      participants     = ${JSON.stringify(d.participants || [])},
      top_firms        = ${JSON.stringify(d.topFirms || [])},
      derived_v        = ${derivedV}
    WHERE investigation_number = ${number} AND investigation_phase = ${phase}`;
}

// Upsert a batch of documents. Chunked multi-row INSERT for throughput; the PK
// makes re-ingestion idempotent (metadata is refreshed on conflict).
export async function upsertDocuments(docs) {
  await ensureItcSchema();
  if (!docs.length) return 0;
  // EDIS can list the same document id more than once within an investigation
  // (e.g. a paper cross-filed across phases). A multi-row INSERT ... ON CONFLICT
  // cannot update the same row twice in one statement ("cannot affect row a
  // second time"), so collapse duplicate ids first (last occurrence wins).
  const byId = new Map();
  for (const d of docs) if (d && d.id) byId.set(String(d.id), d);
  const unique = [...byId.values()];
  const CHUNK = 200;
  let n = 0;
  for (let i = 0; i < unique.length; i += CHUNK) {
    const batch = unique.slice(i, i + CHUNK);
    const vals = [];
    const params = [];
    batch.forEach((d, j) => {
      const b = j * 12;
      vals.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8},$${b + 9},$${b + 10},$${b + 11},$${b + 12})`);
      params.push(d.id, d.number, d.phase || null, d.documentType || null, d.documentTitle || null,
        d.securityLevel || null, d.firmOrganization || null, d.filedBy || null, d.onBehalfOf || null,
        d.documentDate || null, d.receivedDate || null, d.attachmentListUri || null);
    });
    const text =
      `INSERT INTO itc_document
         (id, investigation_number, investigation_phase, document_type, document_title,
          security_level, firm_organization, filed_by, on_behalf_of, document_date,
          received_date, attachment_list_uri)
       VALUES ${vals.join(',')}
       ON CONFLICT (id) DO UPDATE SET
         document_type     = EXCLUDED.document_type,
         document_title    = EXCLUDED.document_title,
         security_level    = EXCLUDED.security_level,
         firm_organization = EXCLUDED.firm_organization,
         filed_by          = EXCLUDED.filed_by,
         on_behalf_of      = EXCLUDED.on_behalf_of,
         document_date     = EXCLUDED.document_date,
         received_date     = EXCLUDED.received_date,
         attachment_list_uri = EXCLUDED.attachment_list_uri`;
    await sql.query(text, params);
    n += batch.length;
  }
  return n;
}

// All documents for one investigation number (any phase), oldest first — the
// input to the per-investigation derivation.
export async function documentsForInvestigation(number) {
  await ensureItcSchema();
  const { rows } = await sql`
    SELECT id, investigation_phase, document_type, document_title, security_level,
           firm_organization, on_behalf_of, document_date, received_date
    FROM itc_document WHERE investigation_number = ${number}
    ORDER BY received_date ASC NULLS LAST, id ASC`;
  return rows;
}

// Full document set for one investigation number (all phases), NEWEST first —
// the basis for the per-investigation detail-page Blob (itc/inv/<number>.json).
export async function documentsForDetail(number) {
  await ensureItcSchema();
  const { rows } = await sql`
    SELECT id, investigation_phase, document_type, document_title, security_level,
           firm_organization, filed_by, on_behalf_of, document_date, received_date
    FROM itc_document WHERE investigation_number = ${number}
    ORDER BY received_date DESC NULLS LAST, id DESC`;
  return rows;
}

// The full investigation catalog + derivations — the basis for the Blob projection.
export async function listInvestigations() {
  await ensureItcSchema();
  const { rows } = await sql`
    SELECT investigation_number, investigation_phase, public_number, title, status,
           docket_number, institution_date, last_doc_date, doc_count, public_doc_count,
           outcome, remedy, review_flag, participants, top_firms
    FROM itc_investigation
    ORDER BY investigation_number DESC, investigation_phase ASC`;
  return rows;
}

export async function logScan(mode, invCount, docCount, note) {
  await ensureItcSchema();
  await sql`INSERT INTO itc_scan_log (mode, inv_count, doc_count, note)
            VALUES (${mode}, ${invCount ?? null}, ${docCount ?? null}, ${note || null})`;
}

// Distinct investigation numbers that already have documents in the DB — the
// derive-only mode (re-derive + republish without re-crawling) works over these.
export async function numbersWithDocuments() {
  await ensureItcSchema();
  const { rows } = await sql`SELECT DISTINCT investigation_number FROM itc_document ORDER BY investigation_number`;
  return rows.map((r) => r.investigation_number);
}

export async function investigationNumbers({ activeOnly = false } = {}) {
  await ensureItcSchema();
  const { rows } = activeOnly
    ? await sql`SELECT DISTINCT investigation_number FROM itc_investigation WHERE status = 'Active' ORDER BY investigation_number`
    : await sql`SELECT DISTINCT investigation_number FROM itc_investigation ORDER BY investigation_number`;
  return rows.map((r) => r.investigation_number);
}
