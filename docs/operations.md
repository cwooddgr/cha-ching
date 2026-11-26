# Operations: code, imports, deploy

> **Author:** Claude Code (coder) · **Date:** 2026-09-26 · **Status:** moved verbatim from `CLAUDE.md` when it was slimmed (decided-by-user 2026-09-26); provenance stamps inside the text are the originals.

Guidance for Claude Code working in this repo — and, just as importantly, the
operating context for the **analyst agent** behind rev-9000.dgrlabs.co's
ANALYST CONSOLE panel. That agent is Claude Code running on dgrhub with this
directory as its working directory (see `house/bin/agent-bridge`), so this
file *is* its system prompt in everything but name.

These counting rules used to live in a `CHAT_SYSTEM` string inside
`src/index.js`, back when the console called the Anthropic API from the Worker.
They moved here on 2026-08-09 when the console switched to Claude Code on
Charlie's subscription. **If you change how a figure is counted, change it
here** — this is the copy that reaches the model.

## What this project is

A Cloudflare Worker that receives [App Store Server Notifications V2], stores
every notification in D1, posts formatted messages to Slack, and serves an
FUI-styled analytics dashboard. Covers every DGR Labs app. Tier: this is live
production telemetry for real revenue — treat the data as authoritative and
the ingest path as fragile.

## Working on the code (not the data)

- `src/index.js` — the whole Worker: ingest, Slack, stats, the analyst
  endpoints. `public/` is the dashboard (no build step).
- **Telemetry snapshot** (`snapshotActiveUsers` in `src/index.js`) — the
  daily cron (`[triggers]` in `wrangler.toml`, 01:20 UTC) that fills
  `active_users` from Overflight's Analytics Engine dataset through the AE SQL
  API. Needs `CF_ACCOUNT_ID` (a var) and the `CF_ANALYTICS_TOKEN` secret
  (Account Analytics Read). `POST /api/usage-snapshot` (bearer
  `DASHBOARD_SECRET`, workers.dev) runs the same thing by hand; both skip
  days already held, so either can run any time. A new app with telemetry
  is one entry in `TELEMETRY_SOURCES`.
- `scripts/analytics-import.mjs` — pulls Apple's "App Sessions Standard"
  analytics report (daily/weekly/monthly active devices) into `app_sessions`.
  Same Finance-role key as the sales import; that role can download reports
  but not create the per-app ONGOING report request — those exist for all
  five App Store apps (created before 2026-08-25) and a new app's needs an
  Admin key once. The Worker's `/api/analytics-import` bootstraps the tables
  on first use because `wrangler d1 execute --remote` 403s from the laptop.
  Runs **daily** on dgrhub at 03:15, 10:15, and 18:15 MT (see "Scheduled
  imports" below); idempotent, so later runs of a day are no-ops once Apple
  has published.
- `scripts/sales-import.mjs` — pulls Apple's daily sales reports into `sales`.
  Needs an App Store Connect **Team key** with the Finance role (NOT the
  In-App Purchase key `backfill.mjs` uses — Apple restricts that one to the
  App Store Server API). Both `.p8` files and `.backfill.env` are gitignored.
  Re-run any time; it skips days already imported. Runs **weekly** on dgrhub,
  Mondays at 03:00 MT, an hour before leo's weekly cycle. A missed run costs
  nothing; the next one backfills it.

### Scheduled imports (on dgrhub since 2026-11-23)

> **Author:** Claude Code (coder) · **Date:** 2026-11-23 · **Status:** decided-by-user (the move and the Monday-before-leo slot: "move the cha-ching import to dgrhub and run it first"; copying the Finance key: "6a"); the 03:15 analytics run and the failure post to #leo are proposed-by-agent

- Units: house's `deploy/dgrhub-jobs/cha-ching-{sales,analytics}-import.{service,timer}`,
  installed as `co.dgrlabs.house.cha-ching-*-import` LaunchDaemons (run as
  cwood). Both run `scripts/dgrhub-import.sh sales|analytics`, which pulls this
  repo, installs `jose` if missing, sources `/etc/cha-ching/import.env`, and runs
  the importer. Extra args pass through (`dgrhub-import.sh sales --dry-run`).
- Secrets: `/etc/cha-ching/import.env` and the Finance key
  `/etc/cha-ching/AuthKey_Y65YDA78X6.p8`, both root:staff 640. The Mac copies
  in this directory stay for manual runs and `backfill.mjs`.
- Logs: `journalctl -u cha-ching-sales-import` (or `/var/log/house/cha-ching-sales-import.log`).
  A failed run is retried after 2 minutes, then after 10 (rerunning is safe: both importers skip what they hold), and every attempt is logged. Only a run that fails all three attempts posts to #leo via `dgr-notify` and `/etc/leo/slack.env` (2026-11-26, Charlie: "don't report transient errors"; the delays are proposed-by-agent).
- Run now: `ssh dgrhub 'sudo systemctl start cha-ching-sales-import'`.
- Apple's daily sales report is generally out by 8 a.m. PT, so the Monday
  03:00 MT run holds sales through **Saturday**. Sunday's report lands with the
  next week's run.
- The Mac LaunchAgents (`co.dgrlabs.cha-ching.*`, Mondays 10:00 and daily
  10:15/18:15) were unloaded and their plists deleted the same day.
- Deploy: `npx wrangler deploy`. Secrets: `SLACK_WEBHOOK_URL`,
  `DASHBOARD_SECRET`, `CHAT_TOKEN`, `QUERY_TOKEN`, `CF_ANALYTICS_TOKEN`.
- The console's chat proxies to `agent-bridge` on dgrhub; there is no
  Anthropic API key in this project any more, and adding one back would move
  billing off Charlie's subscription.
