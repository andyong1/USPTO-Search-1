#!/usr/bin/env bash
# Nightly ITC Section 337 outcome classification — drains the classify queue in
# bounded batches. Meant to be run by a scheduled Claude task (like grounds-
# topup.sh). One batch per run; resumable, so it drains over several nights and
# then sits at steady state (a few new/updated investigations per night).
#
# Loop: stage -> classify (headless claude -p, per itc-outcome.md) -> upload ->
# republish the main projection. Nothing is mirrored to Blob here; text is in
# Neon and only the small projection JSON is rewritten.
#
# Secrets from grounds-secrets.env (gitignored): POSTGRES_URL, BLOB_READ_WRITE_TOKEN.
# (EDIS_TOKEN is NOT needed — classification reads text already in Neon.)
# Usage:  bash itc-classify-nightly.sh [batchSize]   (default 60)

set -uo pipefail
cd "$(dirname "$0")"

if [ ! -f grounds-secrets.env ]; then echo "ERROR: grounds-secrets.env not found (POSTGRES_URL / BLOB_READ_WRITE_TOKEN)"; exit 1; fi
# Strip CRLF when sourcing (the file may have Windows line endings).
set -a; . <(tr -d '\r' < grounds-secrets.env); set +a
export NODE_OPTIONS=--use-system-ca   # use the OS trust store (incl. the corporate SSL-inspection CA)

BATCH="${1:-60}"

echo "== [1/4] stage up to ${BATCH} investigation(s) =="
node itc-outcome-fetch.mjs --limit "${BATCH}"

# Stop early if nothing was staged (queue drained).
STAGED=$(node -e 'try{process.stdout.write(String(require("./itc-work/outcome-work/manifest.json").length))}catch{process.stdout.write("0")}')
if [ "${STAGED}" = "0" ]; then echo "Nothing to classify — queue is drained."; exit 0; fi
echo "   staged ${STAGED}"

echo "== [2/4] classify via headless claude -p (per itc-outcome.md) =="
rm -f itc-work/outcome-work/itc-outcome-out.jsonl
# NOTE: match the claude -p flags your reexam/FWD nightly uses (permission mode,
# model, etc.). The task is self-contained: read the instructions + staged files
# and write the JSONL. Nonzero exit is tolerated — upload handles partial output.
claude -p "Follow itc-outcome.md exactly. Read every file in itc-work/outcome-work/*.txt and append one JSON object per investigation to itc-work/outcome-work/itc-outcome-out.jsonl using that schema. Do not ask questions; just write the file." \
  --permission-mode acceptEdits || echo "   (claude -p returned nonzero; continuing with whatever JSONL was written)"

if [ ! -s itc-work/outcome-work/itc-outcome-out.jsonl ]; then echo "No classifier output produced — skipping upload."; exit 1; fi

echo "== [3/4] upload outcomes to Neon =="
node itc-outcome-upload.mjs

echo "== [4/4] republish main projection =="
node edis-upload.mjs --publish-only

echo "== ITC classify run complete =="
