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
    created_at         timestamptz NOT NULL DEFAULT now()
  )`;
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
  schemaReady = true;
}

export async function listWatched() {
  await ensureSchema();
  const { rows } = await sql`
    SELECT application_number, label, created_at
    FROM watched_applications
    ORDER BY created_at DESC`;
  return rows;
}

export async function addWatched(appNum, label) {
  await ensureSchema();
  await sql`
    INSERT INTO watched_applications (application_number, label)
    VALUES (${appNum}, ${label || null})
    ON CONFLICT (application_number) DO UPDATE SET label = EXCLUDED.label`;
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
export async function syncApplication(appNum, markNew) {
  await ensureSchema();
  const docs = await fetchDocuments(appNum);
  const addedDocs = [];
  for (const d of docs) {
    const { rowCount } = await sql`
      INSERT INTO seen_documents
        (application_number, document_identifier, document_code, description,
         official_date, direction, formats, is_new)
      VALUES (${appNum}, ${d.documentIdentifier}, ${d.documentCode}, ${d.description},
              ${d.officialDate}, ${d.direction}, ${d.formats.join(',')}, ${markNew})
      ON CONFLICT (application_number, document_identifier) DO NOTHING`;
    if (rowCount > 0) {
      addedDocs.push({ applicationNumber: appNum, ...d, formats: d.formats });
    }
  }
  return { total: docs.length, added: addedDocs.length, addedDocs };
}
