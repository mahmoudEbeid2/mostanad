#!/usr/bin/env bash
# Runs the certificates acceptance (scripts/acceptance/certificates.mjs) on PRODUCTION, from a workstation:
#   bash scripts/acceptance/run-prod.sh [--keep] [--only 1,2,…]
# The 5 fixtures (fixtures/addvet/, not in git) and the script go into ONE run folder, on the host and in the
# app container; that folder alone is removed afterwards, by its exact name. Nothing else is deleted.
set -euo pipefail
HOST="${PROD_HOST:-root@191.218.161.132}"
KEY="${PROD_KEY:-$HOME/.ssh/dossira_deploy_ed25519}"
HERE="$(cd "$(dirname "$0")/../.." && pwd)"
FIX="$HERE/fixtures/addvet"
FILES=("ADDVET OMAN COC 10-26.pdf" "ADDVET OMAN COA 10-26.pdf" "ADDVET HC OMAN 10-26.pdf" "MADADD2610001.pdf" "BRN2025002 - ROSHAN.pdf")
for f in "${FILES[@]}"; do [ -f "$FIX/$f" ] || { echo "missing fixture: $FIX/$f (see fixtures/addvet/README.md)"; exit 2; }; done

RUN="acceptance-$(date +%Y%m%d-%H%M%S)-$$"
REMOTE="/tmp/$RUN"            # on the host
INSIDE="/tmp/$RUN"            # in the container
SSH=(ssh -i "$KEY" -o ConnectTimeout=20 "$HOST")

"${SSH[@]}" "mkdir '$REMOTE' '$REMOTE/files'"
scp -q -i "$KEY" "$HERE/scripts/acceptance/certificates.mjs" "$HOST:$REMOTE/certificates.mjs"
for f in "${FILES[@]}"; do scp -q -i "$KEY" "$FIX/$f" "$HOST:$REMOTE/files/"; done

set +e
"${SSH[@]}" "docker cp '$REMOTE' 'mostanad-app:$INSIDE' \
  && docker exec mostanad-app mkdir -p /app/scripts/acceptance \
  && docker exec mostanad-app cp '$INSIDE/certificates.mjs' /app/scripts/acceptance/certificates.mjs \
  && docker exec mostanad-app node /app/scripts/acceptance/certificates.mjs --files '$INSIDE/files' $*"
CODE=$?
set -e

# only this run's folder, by its exact name (never a pattern)
"${SSH[@]}" "docker exec mostanad-app rm -r -- '$INSIDE'; rm -r -- '$REMOTE'" || echo "note: could not remove $REMOTE / $INSIDE"
exit $CODE
