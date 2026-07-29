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
const ITC_SCHEMA_VERSION = '2026-07-29.2';

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
  // Local mirror of key public PDFs to Blob — Vercel's serverless egress is
  // IP-blocked by EDIS's WAF, and anonymous API access cannot download
  // attachments, so downloads are mirrored locally (with a token) and served
  // from Blob. mirror_url: the Blob URL on success, '' when permanently
  // unavailable, NULL = not yet attempted (the mirror queue gate).
  await sql`ALTER TABLE itc_document ADD COLUMN IF NOT EXISTS mirror_url text`;
  await sql`ALTER TABLE itc_document ADD COLUMN IF NOT EXISTS mirror_att_id text`;
  await sql`ALTER TABLE itc_document ADD COLUMN IF NOT EXISTS mirror_size int`;
  await sql`ALTER TABLE itc_document ADD COLUMN IF NOT EXISTS mirror_at timestamptz`;

  // ── Phase 2: dispositive-document text + AI outcome ──────────────────
  // Extracted text of the small "dispositive" document set per investigation
  // (Commission opinion, final ID, remedy/consent orders, Commission notices).
  // Text is CAPPED (head+tail) by the extractor to stay within Neon's free tier.
  await sql`CREATE TABLE IF NOT EXISTS itc_doc_text (
    doc_id               text PRIMARY KEY,
    investigation_number text NOT NULL,
    doc_role             text,   -- opinion|final_id|remedy_order|consent_order|commission_order|commission_notice|partial_id
    document_type        text,
    document_title       text,
    received_date        text,
    text                 text,
    char_count           int,
    text_source          text,   -- pdf | ocr
    extracted_v          int DEFAULT 0,
    fetched_at           timestamptz NOT NULL DEFAULT now()
  )`;
  await sql`CREATE INDEX IF NOT EXISTS itc_doc_text_inv_idx ON itc_doc_text (investigation_number)`;

  // One AI-classified outcome per investigation number (investigation-level;
  // ai_respondents/ai_patents reserved for the later per-respondent pass).
  await sql`CREATE TABLE IF NOT EXISTS itc_outcome (
    investigation_number text PRIMARY KEY,
    ai_disposition       text,   -- violation_found|no_violation|terminated_settlement|terminated_consent|terminated_default|terminated_withdrawal|terminated_arbitration|pending
    ai_violation         text,   -- full | partial | none
    ai_remedies          jsonb,  -- ["LEO","GEO","CDO"]
    ai_commission_action text,   -- affirmed|reversed|modified|affirmed_in_part|not_reviewed
    ai_respondents       jsonb,
    ai_patents           jsonb,
    ai_confidence        text,
    ai_note              text,
    ai_source_docs       text[],
    ai_summary           text,   -- plain-English "what the Commission held" blurb
    outcome_ai_v         int DEFAULT 0,
    summary_ai_v         int DEFAULT 0,
    updated_at           timestamptz NOT NULL DEFAULT now()
  )`;
  // Added after itc_outcome shipped — ALTER for existing DBs.
  await sql`ALTER TABLE itc_outcome ADD COLUMN IF NOT EXISTS ai_summary text`;
  await sql`ALTER TABLE itc_outcome ADD COLUMN IF NOT EXISTS summary_ai_v int DEFAULT 0`;

  // ── Phase 2b: parties + asserted patents (from the Notice of Investigation) ─
  // AI-extracted from the mirrored NOI text (one authoritative public doc per
  // instituted investigation): complainants, the FULL respondent list (incl.
  // defaulters, who never file an answer), asserted patents, accused products,
  // and the requested remedies. Enables role-split firm/party tables and the
  // patent bridge to the PTAB/reexam trackers.
  await sql`CREATE TABLE IF NOT EXISTS itc_parties (
    investigation_number text PRIMARY KEY,
    complainants         jsonb,   -- ["Archer Aviation Inc."]
    respondents          jsonb,   -- ["Joby Aero, Inc.","Joby Aviation, Inc."] (individual entities)
    asserted_patents     jsonb,   -- ["11,945,594","12,162,614", …] (digits+commas, no "US"/"the '594 patent")
    accused_products     text,    -- short phrase, e.g. "electric aircraft and power systems"
    requested_remedies   jsonb,   -- ["LEO","GEO","CDO"] as requested in the complaint
    parties_confidence   text,    -- high | medium | low
    parties_note         text,
    parties_source_doc   text,    -- NOI docId relied on
    parties_ai_v         int DEFAULT 0,
    updated_at           timestamptz NOT NULL DEFAULT now()
  )`;

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
           firm_organization, filed_by, on_behalf_of, document_date, received_date, mirror_url
    FROM itc_document WHERE investigation_number = ${number}
    ORDER BY received_date DESC NULLS LAST, id DESC`;
  return rows;
}

// Key document types worth mirroring to Blob (the "Key document types" scope):
// the papers people actually pull. Matched against document_type OR title.
// Tune this list to widen/narrow the mirror. Kept precise (e.g. the complaint's
// own title) to avoid over-mirroring responses/exhibits.
// Title/type patterns for the "key" documents. EDIS typing is messy, so these
// favor precision (e.g. the complaint is caught by its type + "complaint" in the
// title, not a blanket "%complaint%" that also grabs exhibits/appendices). The
// broad "%institution of investigation%" was dropped — it matched postponement
// letters. Tune freely; the mirror re-checks anything still unmirrored.
export const KEY_DOC_PATTERNS = [
  '%notice of investigation%', '%public complaint%', '%complaint under section 337%',
  '%initial determination%', '%final initial determination%',
  '%commission opinion%', '%commission determination%',
  '%limited exclusion order%', '%general exclusion order%',
  '%cease and desist order%', '%consent order%',
];

// Public, not-yet-mirrored, key-type docs; optionally scoped to one investigation
// number (null = all). The trailing clause catches the actual complaint (type
// "Complaint" with "complaint" in the title) while excluding appendices/exhibits.
// @vercel/postgres `sql` executes immediately and isn't composable, so the WHERE
// is written inline in each function rather than shared as a fragment.
export async function keyPublicDocsToMirror(limit, number) {
  await ensureItcSchema();
  const p = KEY_DOC_PATTERNS;
  const n = number || null;
  const { rows } = await sql`
    SELECT id, investigation_number, document_type, document_title
    FROM itc_document
    WHERE (${n}::text IS NULL OR investigation_number = ${n})
      AND lower(security_level) = 'public' AND mirror_url IS NULL
      AND ( document_type ILIKE ANY(${p}) OR document_title ILIKE ANY(${p})
            OR (document_type ILIKE 'complaint' AND document_title ILIKE '%complaint%') )
    ORDER BY received_date DESC NULLS LAST LIMIT ${limit}`;
  return rows;
}

export async function countKeyPublicDocsToMirror(number) {
  await ensureItcSchema();
  const p = KEY_DOC_PATTERNS;
  const n = number || null;
  const { rows } = await sql`
    SELECT count(*)::int AS n FROM itc_document
    WHERE (${n}::text IS NULL OR investigation_number = ${n})
      AND lower(security_level) = 'public' AND mirror_url IS NULL
      AND ( document_type ILIKE ANY(${p}) OR document_title ILIKE ANY(${p})
            OR (document_type ILIKE 'complaint' AND document_title ILIKE '%complaint%') )`;
  return rows[0] ? rows[0].n : 0;
}

// Investigations that currently have at least one mirrored PDF (real Blob URL) —
// the set whose detail blobs must be republished after a mirror wipe.
export async function mirroredInvestigationNumbers() {
  await ensureItcSchema();
  const { rows } = await sql`SELECT DISTINCT investigation_number FROM itc_document WHERE mirror_url LIKE 'http%'`;
  return rows.map((r) => r.investigation_number);
}

// Clear all real mirror URLs (used when wiping the Blob mirror). Returns the
// number of rows cleared. Leaves '' no-file markers alone.
export async function clearAllMirrorUrls() {
  await ensureItcSchema();
  const { rowCount } = await sql`UPDATE itc_document
    SET mirror_url = NULL, mirror_att_id = NULL, mirror_size = NULL, mirror_at = NULL
    WHERE mirror_url LIKE 'http%'`;
  return rowCount;
}

// Record a mirror result: the Blob URL on success, or '' when the document has
// no downloadable attachment (so it isn't retried every run).
export async function setDocumentMirror(id, url, attId, size) {
  await sql`UPDATE itc_document SET mirror_url = ${url}, mirror_att_id = ${attId || null},
              mirror_size = ${size || null}, mirror_at = now() WHERE id = ${id}`;
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

// ── Phase 2: dispositive text extraction ───────────────────────────────
// Investigations that have at least one strong dispositive document type, newest
// activity first — the queue for text extraction (skip title-only 'Notice'/'Order').
export async function investigationsToExtract(limit, number) {
  await ensureItcSchema();
  const n = number || null;
  const { rows } = await sql`
    SELECT investigation_number, max(received_date) AS r
    FROM itc_document
    WHERE (${n}::text IS NULL OR investigation_number = ${n})
      AND document_type IN ('Opinion, Commission','ID/RD - Final on Violation','Order, Commission','ID/RD - Other Than Final on Violation')
    GROUP BY investigation_number
    ORDER BY r DESC NULLS LAST
    LIMIT ${limit}`;
  return rows.map((row) => row.investigation_number);
}

// Doc ids already extracted for this investigation at >= version v (to skip).
export async function extractedDocIds(number, v) {
  await ensureItcSchema();
  const { rows } = await sql`SELECT doc_id FROM itc_doc_text WHERE investigation_number = ${number} AND extracted_v >= ${v}`;
  return new Set(rows.map((row) => row.doc_id));
}

export async function upsertDocText(t) {
  await ensureItcSchema();
  await sql`INSERT INTO itc_doc_text
      (doc_id, investigation_number, doc_role, document_type, document_title, received_date, text, char_count, text_source, extracted_v)
    VALUES (${t.docId}, ${t.number}, ${t.role || null}, ${t.type || null}, ${t.title || null}, ${t.date || null},
            ${t.text || null}, ${t.charCount || 0}, ${t.source || null}, ${t.v})
    ON CONFLICT (doc_id) DO UPDATE SET
      doc_role = EXCLUDED.doc_role, document_type = EXCLUDED.document_type, document_title = EXCLUDED.document_title,
      received_date = EXCLUDED.received_date, text = EXCLUDED.text, char_count = EXCLUDED.char_count,
      text_source = EXCLUDED.text_source, extracted_v = EXCLUDED.extracted_v, fetched_at = now()`;
}

// ── Phase 2: AI outcome classification ─────────────────────────────────
// Investigations with extracted dispositive text not yet classified at version v
// (or behind it), newest activity first — the classify queue.
export async function investigationsToClassify(limit, v, number) {
  await ensureItcSchema();
  const n = number || null;
  const { rows } = await sql`
    SELECT t.investigation_number, max(t.received_date) AS r
    FROM itc_doc_text t
    LEFT JOIN itc_outcome o ON o.investigation_number = t.investigation_number
    WHERE (${n}::text IS NULL OR t.investigation_number = ${n})
      AND coalesce(t.text, '') <> ''
      AND coalesce(o.outcome_ai_v, 0) < ${v}
    GROUP BY t.investigation_number
    ORDER BY r DESC NULLS LAST
    LIMIT ${limit}`;
  return rows.map((x) => x.investigation_number);
}

export async function countInvestigationsToClassify(v) {
  await ensureItcSchema();
  const { rows } = await sql`
    SELECT count(*)::int AS n FROM (
      SELECT t.investigation_number
      FROM itc_doc_text t
      LEFT JOIN itc_outcome o ON o.investigation_number = t.investigation_number
      WHERE coalesce(t.text, '') <> '' AND coalesce(o.outcome_ai_v, 0) < ${v}
      GROUP BY t.investigation_number) q`;
  return rows[0] ? rows[0].n : 0;
}

// The extracted dispositive documents (with text) for one investigation — the
// input the AI classifier reads, newest first.
export async function dispositiveTextForInvestigation(number) {
  await ensureItcSchema();
  const { rows } = await sql`
    SELECT doc_id, doc_role, document_title, received_date, text_source, text
    FROM itc_doc_text
    WHERE investigation_number = ${number} AND coalesce(text, '') <> ''
    ORDER BY received_date DESC NULLS LAST`;
  return rows;
}

// All classified outcomes (for the projection). Keyed by investigation number.
export async function listOutcomes() {
  await ensureItcSchema();
  const { rows } = await sql`
    SELECT investigation_number, ai_disposition, ai_violation, ai_remedies,
           ai_commission_action, ai_confidence, ai_note, ai_summary
    FROM itc_outcome WHERE ai_disposition IS NOT NULL`;
  return rows;
}

// ── Phase 2c: plain-English Commission-holding summaries ────────────────
export const SUMMARY_AI_V = 1;   // bump to force re-summarization of every investigation

// Investigations that have extracted dispositive text but no summary at version v
// (newest activity first) — the summary queue. Independent of the outcome pass.
export async function investigationsToSummarize(limit, v, number) {
  await ensureItcSchema();
  const n = number || null;
  const { rows } = await sql`
    SELECT t.investigation_number, max(t.received_date) AS r
    FROM itc_doc_text t
    LEFT JOIN itc_outcome o ON o.investigation_number = t.investigation_number
    WHERE (${n}::text IS NULL OR t.investigation_number = ${n})
      AND coalesce(t.text, '') <> ''
      AND coalesce(o.summary_ai_v, 0) < ${v}
    GROUP BY t.investigation_number
    ORDER BY r DESC NULLS LAST
    LIMIT ${limit}`;
  return rows.map((x) => x.investigation_number);
}

export async function countInvestigationsToSummarize(v) {
  await ensureItcSchema();
  const { rows } = await sql`
    SELECT count(*)::int AS n FROM (
      SELECT t.investigation_number
      FROM itc_doc_text t
      LEFT JOIN itc_outcome o ON o.investigation_number = t.investigation_number
      WHERE coalesce(t.text, '') <> '' AND coalesce(o.summary_ai_v, 0) < ${v}
      GROUP BY t.investigation_number) q`;
  return rows[0] ? rows[0].n : 0;
}

// Write one investigation's plain-English holding summary. Upserts the row so it
// works whether or not the outcome pass has run for this investigation yet.
export async function setSummary(number, summary, v) {
  await ensureItcSchema();
  await sql`INSERT INTO itc_outcome (investigation_number, ai_summary, summary_ai_v, updated_at)
    VALUES (${number}, ${summary || null}, ${v}, now())
    ON CONFLICT (investigation_number) DO UPDATE SET
      ai_summary = EXCLUDED.ai_summary, summary_ai_v = EXCLUDED.summary_ai_v, updated_at = now()`;
}

// Write one investigation's AI-classified outcome (versioned).
export async function setOutcome(number, o, v) {
  await ensureItcSchema();
  await sql`INSERT INTO itc_outcome
      (investigation_number, ai_disposition, ai_violation, ai_remedies, ai_commission_action,
       ai_confidence, ai_note, ai_source_docs, outcome_ai_v, updated_at)
    VALUES (${number}, ${o.disposition || null}, ${o.violation || null}, ${JSON.stringify(o.remedies || [])},
            ${o.commissionAction || null}, ${o.confidence || null}, ${o.note || null},
            ${o.sourceDocs && o.sourceDocs.length ? o.sourceDocs : null}, ${v}, now())
    ON CONFLICT (investigation_number) DO UPDATE SET
      ai_disposition = EXCLUDED.ai_disposition, ai_violation = EXCLUDED.ai_violation,
      ai_remedies = EXCLUDED.ai_remedies, ai_commission_action = EXCLUDED.ai_commission_action,
      ai_confidence = EXCLUDED.ai_confidence, ai_note = EXCLUDED.ai_note,
      ai_source_docs = EXCLUDED.ai_source_docs, outcome_ai_v = EXCLUDED.outcome_ai_v, updated_at = now()`;
}

// ── Phase 2b: parties + asserted patents from the NOI ──────────────────
// Bump to force re-extraction of every investigation's parties.
export const PARTIES_AI_V = 1;

// Instituted investigations whose Notice of Investigation is mirrored (public,
// on R2) but whose parties aren't yet extracted at version v — the parties queue,
// newest first. One (earliest) NOI per investigation. Returns {number, noiId, url}.
export async function investigationsForParties(limit, v, number, sinceYear) {
  await ensureItcSchema();
  const n = number || null;
  const sy = sinceYear || null;
  const { rows } = await sql`
    SELECT DISTINCT ON (d.investigation_number)
           d.investigation_number, d.id AS noi_id, d.mirror_url, d.received_date
    FROM itc_document d
    LEFT JOIN itc_parties p ON p.investigation_number = d.investigation_number
    WHERE d.mirror_url LIKE 'http%'
      AND (d.document_title ILIKE 'institution of investigation%'
           OR d.document_title ILIKE 'notice of investigation%'
           OR d.document_title ILIKE 'notice of institution%')
      AND (${n}::text IS NULL OR d.investigation_number = ${n})
      AND (${sy}::int IS NULL OR (d.received_date ~ '^[0-9]{4}' AND left(d.received_date, 4)::int >= ${sy}))
      AND coalesce(p.parties_ai_v, 0) < ${v}
    ORDER BY d.investigation_number, d.received_date ASC`;
  // Newest NOI first, then cap at the batch limit.
  rows.sort((a, b) => String(b.received_date || '').localeCompare(String(a.received_date || '')));
  return rows.slice(0, limit).map((r) => ({ number: r.investigation_number, noiId: r.noi_id, url: r.mirror_url, date: r.received_date }));
}

export async function countInvestigationsForParties(v) {
  await ensureItcSchema();
  const { rows } = await sql`
    SELECT count(*)::int AS n FROM (
      SELECT DISTINCT d.investigation_number
      FROM itc_document d
      LEFT JOIN itc_parties p ON p.investigation_number = d.investigation_number
      WHERE d.mirror_url LIKE 'http%'
        AND (d.document_title ILIKE 'institution of investigation%'
             OR d.document_title ILIKE 'notice of investigation%'
             OR d.document_title ILIKE 'notice of institution%')
        AND coalesce(p.parties_ai_v, 0) < ${v}) q`;
  return rows[0] ? rows[0].n : 0;
}

// Write one investigation's AI-extracted parties/patents (versioned).
export async function setParties(number, p, v) {
  await ensureItcSchema();
  await sql`INSERT INTO itc_parties
      (investigation_number, complainants, respondents, asserted_patents, accused_products,
       requested_remedies, parties_confidence, parties_note, parties_source_doc, parties_ai_v, updated_at)
    VALUES (${number}, ${JSON.stringify(p.complainants || [])}, ${JSON.stringify(p.respondents || [])},
            ${JSON.stringify(p.assertedPatents || [])}, ${p.accusedProducts || null},
            ${JSON.stringify(p.requestedRemedies || [])}, ${p.confidence || null}, ${p.note || null},
            ${p.sourceDoc || null}, ${v}, now())
    ON CONFLICT (investigation_number) DO UPDATE SET
      complainants = EXCLUDED.complainants, respondents = EXCLUDED.respondents,
      asserted_patents = EXCLUDED.asserted_patents, accused_products = EXCLUDED.accused_products,
      requested_remedies = EXCLUDED.requested_remedies, parties_confidence = EXCLUDED.parties_confidence,
      parties_note = EXCLUDED.parties_note, parties_source_doc = EXCLUDED.parties_source_doc,
      parties_ai_v = EXCLUDED.parties_ai_v, updated_at = now()`;
}

// One investigation's AI outcome disposition + holding summary (for the detail blob).
export async function getOutcomeBrief(number) {
  await ensureItcSchema();
  const { rows } = await sql`SELECT ai_disposition, ai_summary FROM itc_outcome WHERE investigation_number = ${number}`;
  return rows[0] || null;
}

// One investigation's extracted parties (for the per-investigation detail blob).
export async function getParties(number) {
  await ensureItcSchema();
  const { rows } = await sql`
    SELECT complainants, respondents, asserted_patents, accused_products,
           requested_remedies, parties_confidence, parties_note
    FROM itc_parties WHERE investigation_number = ${number}`;
  return rows[0] || null;
}

// All extracted parties (for the projection). Keyed by investigation number.
export async function listParties() {
  await ensureItcSchema();
  const { rows } = await sql`
    SELECT investigation_number, complainants, respondents, asserted_patents,
           accused_products, requested_remedies, parties_confidence
    FROM itc_parties WHERE complainants IS NOT NULL OR respondents IS NOT NULL`;
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
