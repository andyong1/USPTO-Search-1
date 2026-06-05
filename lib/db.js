// Postgres helpers (Vercel Postgres / Neon). The @vercel/postgres client reads
// its connection string from POSTGRES_URL, injected automatically when you add
// the Postgres integration in the Vercel dashboard.

import { sql } from '@vercel/postgres';
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

  schemaReady = true;
}

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

// Next chunk to scan: least-recently-scanned, not-yet-determined reexams.
export async function getReexamScanBatch(limit) {
  await ensureSchema();
  const { rows } = await sql`
    SELECT application_number FROM reexam_watch
    WHERE determined = false
    ORDER BY last_scanned_at ASC NULLS FIRST
    LIMIT ${limit}`;
  return rows.map((r) => r.application_number);
}

export async function markReexamScanned(appNum, determined) {
  await sql`UPDATE reexam_watch SET last_scanned_at = now(), determined = ${determined}
            WHERE application_number = ${appNum}`;
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
  if (limit && limit > 0) {
    const { rows } = await sql`
      SELECT application_number, document_identifier, determination_type, official_date,
             group_art_unit, examiner_name, found_at
      FROM reexam_determinations
      ORDER BY official_date DESC NULLS LAST, found_at DESC
      LIMIT ${limit}`;
    return rows;
  }
  const { rows } = await sql`
    SELECT application_number, document_identifier, determination_type, official_date,
           group_art_unit, examiner_name, found_at
    FROM reexam_determinations
    ORDER BY official_date DESC NULLS LAST, found_at DESC`;
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
