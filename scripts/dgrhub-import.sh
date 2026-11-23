#!/bin/bash
# Run one of the App Store Connect imports on dgrhub (moved from Mac LaunchAgents 2026-11-23, decided-by-user:
# "move the cha-ching import to dgrhub and run it first", so leo's Monday 04:00 MT cycle sees last week's sales).
# Usage: dgrhub-import.sh sales|analytics [extra args for the importer, e.g. --dry-run]
# Secrets come from /etc/cha-ching/import.env (the Finance-role key's ids and path, the Worker URL and
# DASHBOARD_SECRET) and the key itself is /etc/cha-ching/AuthKey_<id>.p8; nothing here is in the repo.
# Scheduled by house: deploy/dgrhub-jobs/cha-ching-{sales,analytics}-import.{service,timer}.
# Log: /var/log/house/cha-ching-<kind>-import.log. A failure posts to #leo through dgr-notify.
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
echo "$(date -u +%FT%TZ) cha-ching $KIND import starting"
node "scripts/$KIND-import.mjs" "$@"
rc=$?
echo "$(date -u +%FT%TZ) cha-ching $KIND import done (exit $rc)"
if [ "$rc" -ne 0 ] && [ -r /etc/leo/slack.env ]; then
  msg="$(mktemp)"
  printf 'cha-ching %s import failed on dgrhub (exit %s). Log: /var/log/house/cha-ching-%s-import.log\n' "$KIND" "$rc" "$KIND" > "$msg"
  ( set -a; . /etc/leo/slack.env; set +a; dgr-notify slack "$msg" ) || echo "dgr-notify failed too"
  rm -f "$msg"
fi
exit "$rc"
