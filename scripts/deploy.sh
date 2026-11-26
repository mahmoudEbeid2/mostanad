#!/usr/bin/env bash
# Production deploy of the backend (28 Nov). Run on the server: bash scripts/deploy.sh
#   1. a database backup (/root/backups)
#   2. today's images kept as :rollback, the new code pulled and built
#   3. the API started (migrations run at boot), then every worker — harvest-worker included
#   4. checks: /health, /health/workers (every queue has a connected worker), and the harvest smoke test
#      (a small PDF read end to end by harvest-worker within 2 minutes)
#   5. any check failing → the :rollback images are put back and started; the deploy fails with the reason.
#      No broken deploy is left live. (Migrations are additive: the old code runs on the new schema.)
set -uo pipefail
cd "$(dirname "$0")/.."
C="docker compose -f docker-compose.prod.yml"
STAMP=$(date +%Y%m%d%H%M)
# cert-renderer runs the certificate engine (fieldEngine.browser.js is read into its image): built with the rest
SERVICES=$($C config --services 2>/dev/null | grep -E '^mostanad-app$|-worker$|^cert-renderer$' | tr '\n' ' ')
WORKERS=$($C config --services 2>/dev/null | grep -E -- '-worker$|^cert-renderer$' | tr '\n' ' ')
say() { echo "[deploy $(date -u +%H:%M:%S)] $*"; }
fail() {
  say "FAILED — $*"
  $C --profile deploy rm -sf mostanad-app-next >/dev/null 2>&1 # the twin runs the new code: never left serving
  say "rolling back to the previous images"
  for s in $SERVICES; do
    if docker image inspect "mostanad-$s:rollback" >/dev/null 2>&1; then
      docker tag "mostanad-$s:rollback" "mostanad-$s:latest"
      $C up -d --no-deps "$s" >/dev/null 2>&1
    elif [ "$s" = "harvest-worker" ]; then
      $C stop harvest-worker >/dev/null 2>&1 # new with this deploy: nothing to go back to
    fi
  done
  say "rolled back (code on disk stays at $(git rev-parse --short HEAD); previous was $PREV)"
  exit 1
}
inapp() { docker exec mostanad-app node -e "$1"; }

say "backup"
$C exec -T postgres pg_dump -U mostanad_app -Fc mostanad_app > "/root/backups/mostanad_predeploy_$STAMP.dump" || { say "backup failed — nothing changed"; exit 1; }
ls -la "/root/backups/mostanad_predeploy_$STAMP.dump" | awk '{print "[deploy] backup " $5 " bytes"}'

PREV=$(git rev-parse --short HEAD)
for s in $SERVICES; do docker image inspect "mostanad-$s:latest" >/dev/null 2>&1 && docker tag "mostanad-$s:latest" "mostanad-$s:rollback"; done
say "pull ($PREV →)"
git pull -q --ff-only || { say "git pull failed — nothing changed"; exit 1; }
say "now $(git log --oneline -1 | cut -c1-80)"

say "build $SERVICES"
$C build $SERVICES > "/root/backups/build_$STAMP.log" 2>&1 || { say "build failed (log /root/backups/build_$STAMP.log) — nothing changed"; exit 1; }

# zero downtime (27 Nov QA: each deploy took the API down 20–40 s): a twin on the new image takes the
# traffic first (same Traefik service, routed once healthy), the API restarts behind it, the twin goes
say "start the API (a twin on the new image answers meanwhile)"
twin=0
if $C --profile deploy up -d --no-deps --no-build mostanad-app-next >/dev/null 2>&1; then
  for i in $(seq 1 60); do
    [ "$(docker inspect -f '{{.State.Health.Status}}' mostanad-app-next 2>/dev/null)" = "healthy" ] && { twin=1; break; }
    sleep 3
  done
fi
if [ $twin = 1 ]; then say "the twin answers — the API restarts behind it"; else say "the twin didn't come up — a plain restart"; $C --profile deploy rm -sf mostanad-app-next >/dev/null 2>&1; fi
$C up -d --no-deps mostanad-app >/dev/null 2>&1
# (the log is captured first: with pipefail, "logs | grep -q" fails when grep stops at the first match)
started=0
for i in $(seq 1 90); do
  log=$($C logs --since 5m mostanad-app 2>/dev/null || true)
  case "$log" in *"Starting Mostanad API server"*) started=1; break ;; esac
  sleep 2
done
[ $started = 1 ] || fail "the API didn't start in 3 min (docker logs mostanad-app)"
say "start the workers"
$C up -d --no-deps $WORKERS >/dev/null 2>&1

say "check /health"
ok=0
for i in $(seq 1 30); do inapp "fetch('http://localhost:3000/api/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" && { ok=1; break; }; sleep 2; done
[ $ok = 1 ] || fail "/health doesn't answer"
# the API is back and healthy (Traefik routes to it again): the twin goes
for i in $(seq 1 40); do [ "$(docker inspect -f '{{.State.Health.Status}}' mostanad-app 2>/dev/null)" = "healthy" ] && break; sleep 3; done
if [ $twin = 1 ]; then $C --profile deploy rm -sf mostanad-app-next >/dev/null 2>&1; say "the twin stopped"; fi

say "check /health/workers"
ok=0
for i in $(seq 1 30); do
  out=$(inapp "fetch('http://localhost:3000/api/v1/health/workers').then(async r=>{const j=await r.json();console.log(JSON.stringify(j.queues));process.exit(r.ok?0:1)}).catch(e=>{console.log(e.message);process.exit(1)})") && { ok=1; break; }
  sleep 3
done
say "queues: $out"
[ $ok = 1 ] || fail "a queue has no connected worker: $out"

say "harvest smoke (a small PDF read end to end, 2 min at most)"
docker exec mostanad-app node scripts/harvestSmoke.js || fail "the harvest smoke test didn't pass (docker logs harvest-worker)"

say "OK — $(git log --oneline -1 | cut -c1-80) is live"
for s in $SERVICES; do docker image rm "mostanad-$s:rollback" >/dev/null 2>&1; done
exit 0
