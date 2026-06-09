// Postgres helpers (Vercel Postgres / Neon). The @vercel/postgres client reads
// its connection string from POSTGRES_URL, injected automatically when you add
// the Postgres integration in the Vercel dashboard.

import { sql } from '@vercel/postgres';
import { randomUUID } from 'node:crypto';
import { fetchDocuments } from './uspto.js';

let schemaReady = false;

export async function ensureSchema() {
  if (schemaReady) return;
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
  await sql`CREATE TABLE IF NOT EXISTS reexam_state (
    id                 int PRIMARY KEY DEFAULT 1,
    last_enumerated_at timestamptz,
    last_digest_at     timestamptz
  )`;
  await sql`INSERT INTO reexam_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING`;
  // Date (YYYY-MM-DD) of the last day a subscriber digest was sent — for idempotency.
  await sql`ALTER TABLE reexam_state ADD COLUMN IF NOT EXISTS last_sub_digest_date text`;

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
  // Office-action timing per ordered reexam: dates of the first non-final (RXR.NF)
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
  // Whether the petition decision includes a 35 U.S.C. 325(d) analysis (from OCR),
  // the OCR job state, and a stored searchable-PDF URL.
  await sql`ALTER TABLE reexam_post_petitions ADD COLUMN IF NOT EXISTS decision_325d boolean`;
  await sql`ALTER TABLE reexam_post_petitions ADD COLUMN IF NOT EXISTS decision_ocr_status text`;
  await sql`ALTER TABLE reexam_post_petitions ADD COLUMN IF NOT EXISTS decision_ocr_job text`;
  await sql`ALTER TABLE reexam_post_petitions ADD COLUMN IF NOT EXISTS decision_pdf_blob_url text`;

  schemaReady = true;
}

// Cutoff for the pre-order SNQ feature (reexams filed on/after this date).
export const PREORDER_CUTOFF = '2026-04-05';

// ── Reexamination watcher helpers ──────────────────────────────────
export async function reexamState() {
  await ensureSchema();
  const { rows } = await sql`SELECT last_enumerated_at, last_digest_at FROM reexam_state WHERE id = 1`;
  return rows[0] || {};
}

export async function setReexamEnumerated() {
  await sql`UPDATE reexam_state SET last_enumerated_at = now() WHERE id = 1`;
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
    values.push(`($${i * 2 + 1},$${i * 2 + 2})`);
    params.push(it.applicationNumber, it.filingDate || null);
  });
  const text =
    `INSERT INTO reexam_watch (application_number, filing_date)
     VALUES ${values.join(',')}
     ON CONFLICT (application_number) DO NOTHING`;
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
  return rowCount > 0;
}

export async function listPreorder() {
  await ensureSchema();
  // Join the (earliest) reexam determination per proceeding, if any.
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
        ORDER BY application_number, official_date ASC NULLS LAST
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
  const { rows } = await sql`
    SELECT
      count(*) FILTER (WHERE d.determination_code = 'RXREXD')::int AS overall_denied,
      count(*) FILTER (WHERE d.determination_code = 'RXREXO')::int AS overall_ordered,
      count(*) FILTER (WHERE d.determination_code = 'RXREXD' AND p.application_number IS NOT NULL)::int AS preorder_denied,
      count(*) FILTER (WHERE d.determination_code = 'RXREXO' AND p.application_number IS NOT NULL)::int AS preorder_ordered
    FROM reexam_determinations d
    JOIN reexam_watch w ON w.application_number = d.application_number
    LEFT JOIN (SELECT DISTINCT application_number FROM reexam_preorder) p
      ON p.application_number = d.application_number
    WHERE w.filing_date >= ${PREORDER_CUTOFF}`;
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
}

// Reexams (filed on/after the cutoff) not yet checked for pre-order — for backfill.
export async function getReexamsForPreorderBackfill(limit) {
  await ensureSchema();
  const { rows } = await sql`
    SELECT application_number, filing_date FROM reexam_watch
    WHERE filing_date >= ${PREORDER_CUTOFF} AND COALESCE(preorder_checked, false) = false
    LIMIT ${limit}`;
  return rows;
}

export async function markPreorderChecked(appNum) {
  await sql`UPDATE reexam_watch SET preorder_checked = true WHERE application_number = ${appNum}`;
}

// Clear the pre-order checked flag so the backfill re-scans all post-cutoff reexams.
export async function resetPreorderChecked() {
  await ensureSchema();
  const { rowCount } = await sql`
    UPDATE reexam_watch SET preorder_checked = false WHERE filing_date >= ${PREORDER_CUTOFF}`;
  return rowCount;
}

export async function countReexamsForPreorderBackfill() {
  await ensureSchema();
  const { rows } = await sql`
    SELECT count(*)::int AS n FROM reexam_watch
    WHERE filing_date >= ${PREORDER_CUTOFF} AND COALESCE(preorder_checked, false) = false`;
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

// ── Reexam conclusions (NIRC / certificate + parsed claim outcome) ──
// Ordered reexams (RXREXO) not yet concluded (no certificate found) and not
// checked within the last 7 days — the rolling pool to look for a NIRC/certificate.
export async function getDeterminationsToCheckConclusion(limit) {
  await ensureSchema();
  const { rows } = await sql`
    SELECT d.application_number, w.filing_date
    FROM (SELECT DISTINCT application_number FROM reexam_determinations WHERE determination_code = 'RXREXO') d
    LEFT JOIN reexam_conclusions c ON c.application_number = d.application_number
    LEFT JOIN reexam_watch w ON w.application_number = d.application_number
    WHERE c.cert_doc_id IS NULL
      AND (c.checked_at IS NULL OR c.checked_at < now() - interval '7 days')
    ORDER BY c.checked_at ASC NULLS FIRST
    LIMIT ${limit}`;
  return rows;
}

// Record (upsert) the NIRC/certificate documents found for a proceeding; always
// stamps checked_at. New cert/NIRC ids leave parsed=false so the parse step runs.
export async function recordConclusionDocs(appNum, d) {
  await ensureSchema();
  await sql`
    INSERT INTO reexam_conclusions (application_number, nirc_doc_id, nirc_date, cert_doc_id, cert_date, checked_at)
    VALUES (${appNum}, ${d.nircDocId || null}, ${d.nircDate || null}, ${d.certDocId || null}, ${d.certDate || null}, now())
    ON CONFLICT (application_number) DO UPDATE SET
      nirc_doc_id = COALESCE(EXCLUDED.nirc_doc_id, reexam_conclusions.nirc_doc_id),
      nirc_date   = COALESCE(EXCLUDED.nirc_date,   reexam_conclusions.nirc_date),
      cert_doc_id = COALESCE(EXCLUDED.cert_doc_id, reexam_conclusions.cert_doc_id),
      cert_date   = COALESCE(EXCLUDED.cert_date,   reexam_conclusions.cert_date),
      checked_at  = now()`;
}

// Conclusions that have a NIRC/certificate document but no parsed outcome yet.
export async function getConclusionsToParse(limit) {
  await ensureSchema();
  const { rows } = await sql`
    SELECT application_number, cert_doc_id, nirc_doc_id
    FROM reexam_conclusions
    WHERE parsed = false AND (cert_doc_id IS NOT NULL OR nirc_doc_id IS NOT NULL)
    ORDER BY found_at ASC
    LIMIT ${limit}`;
  return rows;
}

export async function setConclusionOutcome(appNum, o) {
  await ensureSchema();
  await sql`
    UPDATE reexam_conclusions SET
      outcome_summary  = ${o ? o.summary : null},
      claims_confirmed = ${o ? o.confirmed : null},
      claims_cancelled = ${o ? o.cancelled : null},
      claims_amended   = ${o ? o.amended : null},
      claims_new       = ${o ? o.added : null},
      parsed           = true
    WHERE application_number = ${appNum}`;
}

// ── Post-grant patent owner petitions (PET.OP) ─────────────────────
// Ordered reexams (RXREXO) not scanned for petitions within the last 7 days.
export async function getOrderedReexamsToCheckPetitions(limit) {
  await ensureSchema();
  const { rows } = await sql`
    SELECT DISTINCT ON (d.application_number) d.application_number, d.official_date AS order_date
    FROM reexam_determinations d
    LEFT JOIN reexam_petition_scan s ON s.application_number = d.application_number
    WHERE d.determination_code = 'RXREXO'
      AND (s.checked_at IS NULL OR s.checked_at < now() - interval '7 days')
    ORDER BY d.application_number, d.official_date ASC NULLS LAST`;
  // Order by least-recently-checked first, then cap.
  return rows.slice(0, limit);
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
       opposition_doc_id, opposition_date, decision_doc_id, decision_date, decision_outcome)
    VALUES (${appNum}, ${p.orderDate || null}, ${p.petitionDocId || null}, ${p.petitionDate || null}, ${p.petitionPages || null},
            ${p.oppositionDocId || null}, ${p.oppositionDate || null}, ${p.decisionDocId || null}, ${p.decisionDate || null}, ${p.decisionOutcome || null})
    ON CONFLICT (application_number) DO UPDATE SET
      order_date = COALESCE(EXCLUDED.order_date, reexam_post_petitions.order_date),
      petition_doc_id = EXCLUDED.petition_doc_id, petition_date = EXCLUDED.petition_date, petition_pages = EXCLUDED.petition_pages,
      opposition_doc_id = EXCLUDED.opposition_doc_id, opposition_date = EXCLUDED.opposition_date,
      decision_doc_id = EXCLUDED.decision_doc_id, decision_date = EXCLUDED.decision_date, decision_outcome = EXCLUDED.decision_outcome,
      -- When the decision document changes (or first appears), reset OCR state so it re-OCRs.
      decision_325d         = CASE WHEN reexam_post_petitions.decision_doc_id IS DISTINCT FROM EXCLUDED.decision_doc_id THEN NULL ELSE reexam_post_petitions.decision_325d END,
      decision_ocr_status   = CASE WHEN reexam_post_petitions.decision_doc_id IS DISTINCT FROM EXCLUDED.decision_doc_id THEN NULL ELSE reexam_post_petitions.decision_ocr_status END,
      decision_ocr_job      = CASE WHEN reexam_post_petitions.decision_doc_id IS DISTINCT FROM EXCLUDED.decision_doc_id THEN NULL ELSE reexam_post_petitions.decision_ocr_job END,
      decision_pdf_blob_url = CASE WHEN reexam_post_petitions.decision_doc_id IS DISTINCT FROM EXCLUDED.decision_doc_id THEN NULL ELSE reexam_post_petitions.decision_pdf_blob_url END`;
}

// ── Petition-decision OCR (OCR.space) state ────────────────────────
// Decisions with a document but no OCR started yet.
export async function getDecisionsToStartOcr(limit) {
  await ensureSchema();
  const { rows } = await sql`
    SELECT application_number, decision_doc_id
    FROM reexam_post_petitions
    WHERE decision_doc_id IS NOT NULL AND decision_ocr_status IS NULL
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
    WHERE decision_doc_id IS NOT NULL AND decision_ocr_status IS NULL`;
  return rows[0] ? rows[0].n : 0;
}

// Re-pool failed OCR attempts so they're retried.
export async function resetFailedDecisionOcr() {
  await ensureSchema();
  const { rowCount } = await sql`UPDATE reexam_post_petitions SET decision_ocr_status = NULL WHERE decision_ocr_status = 'failed'`;
  return rowCount;
}

// ── Office-action timing (RXR.NF / RXR.F) ──────────────────────────
// Ordered reexams (since the cutoff) not yet checked, or still missing a final
// action and not checked in the last 7 days.
export async function getOrderedReexamsToCheckActions(limit) {
  await ensureSchema();
  const { rows } = await sql`
    SELECT DISTINCT ON (det.application_number) det.application_number, det.official_date AS order_date
    FROM reexam_determinations det
    LEFT JOIN reexam_actions a ON a.application_number = det.application_number
    WHERE det.determination_code = 'RXREXO' AND det.official_date >= '2025-12-22'
      AND (a.application_number IS NULL OR (a.finl_date IS NULL AND (a.checked_at IS NULL OR a.checked_at < now() - interval '7 days')))
    ORDER BY det.application_number, det.official_date ASC NULLS LAST`;
  return rows.slice(0, limit);
}

export async function recordActions(appNum, a) {
  await ensureSchema();
  await sql`
    INSERT INTO reexam_actions (application_number, order_date, nonf_date, nonf_doc_id, finl_date, finl_doc_id, checked_at)
    VALUES (${appNum}, ${a.orderDate || null}, ${a.nonfDate || null}, ${a.nonfDocId || null}, ${a.finlDate || null}, ${a.finlDocId || null}, now())
    ON CONFLICT (application_number) DO UPDATE SET
      order_date  = COALESCE(EXCLUDED.order_date, reexam_actions.order_date),
      nonf_date   = COALESCE(EXCLUDED.nonf_date, reexam_actions.nonf_date),
      nonf_doc_id = COALESCE(EXCLUDED.nonf_doc_id, reexam_actions.nonf_doc_id),
      finl_date   = COALESCE(EXCLUDED.finl_date, reexam_actions.finl_date),
      finl_doc_id = COALESCE(EXCLUDED.finl_doc_id, reexam_actions.finl_doc_id),
      checked_at  = now()`;
}

// Clear all recorded office-action timing so every ordered reexam is re-scanned
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
      WHERE det.determination_code = 'RXREXO' AND det.official_date >= '2025-12-22'
        AND a.application_number IS NULL
    ) t`;
  return rows[0] ? rows[0].n : 0;
}

// Office-action timing rows for the dedicated page, with examiner/art-unit context.
export async function listReexamActions() {
  await ensureSchema();
  const { rows } = await sql`
    SELECT a.application_number, a.order_date, a.nonf_date, a.nonf_doc_id, a.finl_date, a.finl_doc_id,
           d.examiner_name, d.group_art_unit
    FROM reexam_actions a
    LEFT JOIN (
      SELECT DISTINCT ON (application_number) application_number, examiner_name, group_art_unit
      FROM reexam_determinations WHERE determination_code = 'RXREXO'
      ORDER BY application_number, official_date ASC NULLS LAST
    ) d ON d.application_number = a.application_number
    WHERE a.order_date >= '2025-12-22'
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
           p.decision_doc_id, p.decision_date, p.decision_outcome, p.decision_325d, p.decision_pdf_blob_url,
           d.examiner_name, d.group_art_unit
    FROM reexam_post_petitions p
    LEFT JOIN (
      SELECT DISTINCT ON (application_number) application_number, examiner_name, group_art_unit
      FROM reexam_determinations WHERE determination_code = 'RXREXO'
      ORDER BY application_number, official_date ASC NULLS LAST
    ) d ON d.application_number = p.application_number
    WHERE p.order_date >= '2025-12-22'
      -- Drop proceedings whose decision was determined NOT to cite 325(d); keep
      -- pending (not yet decided/OCR'd) and 325(d) decisions.
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

export async function listRecentDeterminations(limit) {
  await ensureSchema();
  // filing_date is joined from reexam_watch (no extra API calls) for pendency.
  if (limit && limit > 0) {
    const { rows } = await sql`
      SELECT d.application_number, d.document_identifier, d.determination_type, d.official_date,
             d.group_art_unit, d.examiner_name, d.found_at, w.filing_date,
             c.cert_doc_id, c.cert_date, c.nirc_doc_id, c.nirc_date, c.outcome_summary
      FROM reexam_determinations d
      LEFT JOIN reexam_watch w ON w.application_number = d.application_number
      LEFT JOIN reexam_conclusions c ON c.application_number = d.application_number
      ORDER BY d.official_date DESC NULLS LAST, d.found_at DESC
      LIMIT ${limit}`;
    return rows;
  }
  const { rows } = await sql`
    SELECT d.application_number, d.document_identifier, d.determination_type, d.official_date,
           d.group_art_unit, d.examiner_name, d.found_at, w.filing_date,
           c.cert_doc_id, c.cert_date, c.nirc_doc_id, c.nirc_date, c.outcome_summary
    FROM reexam_determinations d
    LEFT JOIN reexam_watch w ON w.application_number = d.application_number
    LEFT JOIN reexam_conclusions c ON c.application_number = d.application_number
    ORDER BY d.official_date DESC NULLS LAST, d.found_at DESC`;
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

  const COLS = 8;
  const valueGroups = [];
  const params = [];
  docs.forEach((d, i) => {
    const b = i * COLS;
    valueGroups.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8})`);
    params.push(appNum, d.documentIdentifier, d.documentCode, d.description,
                d.officialDate, d.direction, d.formats.join(','), markNew);
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
  const addedDocs = docs
    .filter((d) => addedIds.has(d.documentIdentifier))
    .map((d) => ({ applicationNumber: appNum, ...d, formats: d.formats }));

  return { total: docs.length, added: addedDocs.length, addedDocs };
}
