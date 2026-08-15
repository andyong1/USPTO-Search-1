// Shared plumbing for the local nightly pipeline scripts (*-fetch / *-upload).
//
// Every one of those scripts had grown the same four things by hand: an env
// guard, --flag parsing, a transient-network retry, and the manifest / JSONL
// dance. Counted across the 65 scripts that was a retry() in 10 files (six
// slightly different variants), --limit parsing in 25, manifest.json handling
// in 36 and the POSTGRES_URL guard in 43 — so a fix to any of them reached one
// script and left the rest as they were.
//
// Deliberately thin: these are utilities the scripts CALL, not a framework that
// calls the scripts. The staging → OCR → verify → upload shape stays visible in
// each script, because that shape is the thing a person has to reason about
// when a pass goes wrong.
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';

// ── Environment ─────────────────────────────────────────────────────────────

/**
 * Exit early, with a message naming what to do, when a required variable is
 * missing. Scripts are launched by hand from a shell that may not have sourced
 * the secrets file, and failing at the first query instead produces a confusing
 * connection error.
 */
export function requireEnv(...names) {
  const missing = names.flat().filter((n) => !process.env[n]);
  if (missing.length) {
    console.error(`${missing.join(' and ')} required — source grounds-secrets.env first.`);
    process.exit(1);
  }
}

// ── Arguments ───────────────────────────────────────────────────────────────

const ARGV = process.argv.slice(2);

/** `--limit 50` → 50. Returns `def` when absent or not a number. */
export function argNum(flag, def) {
  const i = ARGV.indexOf(flag);
  if (i < 0) return def;
  const n = Number(ARGV[i + 1]);
  return Number.isFinite(n) ? n : def;
}

/** `--dir petreq-prod` → 'petreq-prod'. */
export function argStr(flag, def) {
  const i = ARGV.indexOf(flag);
  return i >= 0 && ARGV[i + 1] !== undefined ? ARGV[i + 1] : def;
}

/** `--gap` → true. */
export function argFlag(flag) {
  return ARGV.includes(flag);
}

// ── Retry ───────────────────────────────────────────────────────────────────

// Neon's serverless driver intermittently drops the TLS connection on an
// otherwise fine query, and this network sits behind an SSL-inspecting proxy
// that does the same to rapid outbound connections. Both surface as one of
// these strings. Anything else is a real error and is rethrown immediately —
// retrying a genuine failure just delays the report.
const TRANSIENT = /ECONNRESET|fetch failed|ETIMEDOUT|EPIPE|socket hang up|socket|network|terminated/i;

/**
 * Run `fn`, retrying only transient network failures with linear backoff.
 * A long unattended run must not die on a dropped connection.
 */
export async function retry(label, fn, attempts = 4, baseMs = 1500) {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e) {
      const msg = String((e && e.message) || e);
      if (i >= attempts || !TRANSIENT.test(msg)) throw e;
      const wait = baseMs * i;
      console.log(`  ${label}: transient error (attempt ${i}/${attempts}), retrying in ${wait}ms…`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

// ── Manifest ────────────────────────────────────────────────────────────────
// Each staging pass writes one manifest.json listing what it downloaded, which
// the AI pass reads to know which files to open.

/** Existing manifest, or [] on the first run. */
export async function readManifest(dir) {
  try {
    const raw = JSON.parse(await readFile(`${dir}/manifest.json`, 'utf-8'));
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

export async function writeManifest(dir, entries) {
  await mkdir(dir, { recursive: true });
  await writeFile(`${dir}/manifest.json`, JSON.stringify(entries, null, 1), 'utf-8');
}

/** Manifest keyed by doc_id, for the upload side's "is this ours?" check. */
export async function manifestByDocId(dir) {
  return new Map((await readManifest(dir)).map((m) => [m.doc_id, m]));
}

// ── JSONL results ───────────────────────────────────────────────────────────

/**
 * Parse the AI pass's output, one JSON object per line. Returns the objects
 * plus a count of unparseable lines rather than throwing, so one malformed
 * line cannot discard a whole night's work.
 */
export function parseJsonl(text) {
  const rows = [];
  let bad = 0;
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { bad++; }
  }
  return { rows, bad };
}

/** Read and parse a JSONL file; exits with a usable message when absent. */
export async function readJsonl(path, hint) {
  let raw;
  try {
    raw = await readFile(path, 'utf-8');
  } catch {
    console.error(`No ${path}${hint ? ` — ${hint}` : ''}`);
    process.exit(1);
  }
  return parseJsonl(raw);
}

/**
 * Set the consumed results aside so a re-run cannot upload them twice. Renaming
 * rather than deleting keeps the night's raw output for inspection when a
 * number on a page looks wrong. Best-effort: the upload already succeeded, so a
 * failure to archive must not fail the run.
 */
export async function archiveJsonl(path) {
  try {
    await rename(path, path.replace(/\.jsonl$/, `.${Date.now()}.done.jsonl`));
    return true;
  } catch {
    return false;
  }
}

// ── Teardown ────────────────────────────────────────────────────────────────

/**
 * Close the pooled connection so the process exits instead of hanging. Always
 * safe to call — a driver that is already closed throws, and that is not worth
 * failing a completed run over.
 */
export async function closeDb(sql) {
  try { await sql.end(); } catch { /* already closed */ }
}
