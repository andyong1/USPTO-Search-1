#!/usr/bin/env bash
# One-shot "keep the same-art / §325(d) data current" top-up. Meant to be run by a
# scheduled Claude task (the OCR step needs the agent environment — this machine's
# own python.exe is blocked by DLP). Steps:
#   1. OCR any pipeline determinations we don't have text for yet (download-on-demand)
#   2. upload the new text to Neon
#   3. run the grounds extraction backfill (refs + names + §325(d)) until done
#   4. run the petition-reference backfill a few rounds (heavier; resumable)
#
# Secrets are read from grounds-secrets.env (gitignored) which must define:
#   POSTGRES_URL=postgres://...
#   CRON_SECRET=...
# Usage:  bash grounds-topup.sh
set -uo pipefail
cd "$(dirname "$0")"

if [ ! -f grounds-secrets.env ]; then echo "ERROR: grounds-secrets.env not found (POSTGRES_URL / CRON_SECRET)"; exit 1; fi
set -a; . ./grounds-secrets.env; set +a
export NODE_OPTIONS=--use-system-ca
SITE="${SITE:-https://andy-ong.com}"

echo "== [1/4] OCR new pipeline determinations =="
cat grounds-ocr.py | python -

echo "== [2/4] upload text to Neon =="
node grounds-upload.mjs

# Call a resumable cron endpoint until it reports "done":true (bounded).
drain() { # $1 = url
  for i in $(seq 1 "${2:-20}"); do
    # --ssl-no-revoke: corporate network blocks the CRL/OCSP responder, so schannel
    # can't complete revocation checks for andy-ong.com's cert (CRYPT_E_NO_REVOCATION_CHECK).
    # Human-signed-off TLS trade-off, scoped to this script's own-site calls.
    r=$(curl -fsS --ssl-no-revoke "$1" -H "Authorization: Bearer ${CRON_SECRET}") || { echo "  call failed: $r"; break; }
    echo "  $r"
    echo "$r" | grep -q '"done":true' && break
  done
}

echo "== [3/4] grounds extraction (refs + names + 325(d)) =="
drain "${SITE}/api/cron/backfill-reexam?grounds=1&maxSeconds=45" 10

echo "== [4/5] petition references =="
drain "${SITE}/api/ptab?petrefs=1" 20

# Re-parse related litigation from stored petition front-matter at the current
# LIT_V (cheap, no re-download) — propagates any extractor improvement. No-op once
# everything is current.
echo "== [5/5] litigation re-parse =="
drain "${SITE}/api/ptab?litrescan=1" 20

echo "== top-up complete =="
