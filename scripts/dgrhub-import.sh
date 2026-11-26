#!/bin/bash
# Run one of the App Store Connect imports on dgrhub (moved from Mac LaunchAgents 2026-11-23, decided-by-user:
# "move the cha-ching import to dgrhub and run it first", so leo's Monday 04:00 MT cycle sees last week's sales).
# Usage: dgrhub-import.sh sales|analytics [extra args for the importer, e.g. --dry-run]
# Secrets come from /etc/cha-ching/import.env (the Finance-role key's ids and path, the Worker URL and
# DASHBOARD_SECRET) and the key itself is /etc/cha-ching/AuthKey_<id>.p8; nothing here is in the repo.
# Scheduled by house: deploy/dgrhub-jobs/cha-ching-{sales,analytics}-import.{service,timer}.
# Log: /var/log/house/cha-ching-<kind>-import.log. Failed runs retry after 2 and 10 minutes; only a run that fails every attempt posts to #leo through dgr-notify.
set -uo pipefail
KIND="${1:-}"; shift || true
case "$KIND" in sales|analytics) ;; *) echo "usage: dgrhub-import.sh sales|analytics [args]" >&2; exit 2;; esac
REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"
git pull -q --ff-only || echo "git pull failed; running on the current checkout"
[ -d node_modules/jose ] || npm ci --no-audit --no-fund --loglevel=error
set -a
. /etc/cha-ching/import.env
set +a
# A failed run is retried after 2 minutes, then after 10 (leo inbox 2026-11-26, Charlie: "don't report
# transient errors"; the delays are proposed-by-agent). Both importers skip what they already hold unless
# --force, so a rerun is safe. Every failed attempt stays in the log; Slack hears only if all attempts fail.
# IMPORT_RETRY_DELAYS overrides the delays (space-separated seconds) for testing.
rc=1
attempt=0
for delay in 0 ${IMPORT_RETRY_DELAYS:-120 600}; do
  attempt=$((attempt + 1))
  if [ "$delay" -gt 0 ]; then
    echo "$(date -u +%FT%TZ) cha-ching $KIND import retrying in ${delay}s (attempt $attempt)"
    sleep "$delay"
  fi
  echo "$(date -u +%FT%TZ) cha-ching $KIND import starting (attempt $attempt)"
  node "scripts/$KIND-import.mjs" "$@"
  rc=$?
  echo "$(date -u +%FT%TZ) cha-ching $KIND import done (exit $rc, attempt $attempt)"
  [ "$rc" -eq 0 ] && break
done
if [ "$rc" -ne 0 ] && [ -r /etc/leo/slack.env ]; then
  msg="$(mktemp)"
  printf 'cha-ching %s import failed on dgrhub after %s attempts (exit %s). Log: /var/log/house/cha-ching-%s-import.log\n' "$KIND" "$attempt" "$rc" "$KIND" > "$msg"
  ( set -a; . /etc/leo/slack.env; set +a; dgr-notify slack "$msg" ) || echo "dgr-notify failed too"
  rm -f "$msg"
fi
exit "$rc"
