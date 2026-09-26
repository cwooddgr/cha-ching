# CLAUDE.md

Guidance for Claude Code working in this repo, and the operating context for the **analyst agent** behind rev-9000.dgrlabs.co's ANALYST CONSOLE. That agent is Claude Code (`claude -p`) running on bigiron with this directory as its working directory (see `house/bin/agent-bridge`), so this file and the manual it imports below are its system prompt in everything but name. **If you change how a figure is counted, change it in `docs/analyst.md`**: that is the copy that reaches the model.

**cha-ching**: a Cloudflare Worker that receives App Store Server Notifications V2 for every DGR Labs app, stores each in D1 (`cha-ching`), posts formatted messages to Slack, and serves the FUI analytics dashboard at rev-9000.dgrlabs.co (cha-ching.dgrlabs.co redirects). Tier 3, but live production telemetry for real revenue: treat the data as authoritative and the ingest path as fragile.

## Docs map

| Topic | File |
|---|---|
| Schema, counting rules, active-user sources, answering style (the analyst manual, imported below) | `docs/analyst.md` |
| Code layout, telemetry snapshot, sales and analytics imports, deploy, secrets | `docs/operations.md` |
| Change log and decision history | `NOTES.md` |
| Setup and endpoints | `README.md`, `schema.sql` |

## Commands

```bash
ccq "SELECT …"            # read D1 via the Worker's /api/query: one SELECT or WITH…SELECT, JSON rows, 200-row cap
ccq --schema             # ccq is on PATH on bigiron; here: npm run ccq -- "SELECT …" (scripts/ccq.mjs)
npx wrangler deploy       # deploy the Worker
node scripts/sales-import.mjs       # Apple daily sales reports → sales (launchd weekly, Mondays 10:00)
node scripts/analytics-import.mjs   # App Sessions report → app_sessions (launchd daily 10:15 and 18:15)
```

## Architecture in brief

- `src/index.js` is the whole Worker: ingest, Slack, `/api/stats`, the analyst endpoints (`/api/query` behind the SELECT-only guard), and the 01:20 UTC cron that snapshots Overflight telemetry into `active_users`. `public/` is the dashboard, no build step.
- The console's chat proxies to `agent-bridge` on bigiron (Claude Code on Charlie's subscription since 2026-08-09).
- Launchd agents for the imports: `scripts/co.dgrlabs.cha-ching.*.plist`.

## Rules that have bitten us

- Never try to work around `ccq`'s SELECT-only guard; it is the only thing between the console and a write handle on revenue data. A write is a human's job with wrangler.
- Always filter to `environment = 'Production'`, and always exclude `in_app_ownership_type = 'FAMILY_SHARED'` from revenue, purchase counts, and conversion (it once inflated CD Wally's unlocks from 23 to 56).
- Never apply 85% for proceeds; derive the rate from `sales`. Refund rows carry negative `units` and negative `customer_price` (gross is `units * ABS(customer_price)`).
- Never join `notifications`, `sales`, and `app_sessions` on a date; their days are UTC, Pacific, and Apple report days.
- Never sum daily uniques into a monthly figure. There is no rolling 30-day number in Apple's data.
- `active_users` is the only long-term record of Overflight telemetry (Analytics Engine keeps three months); never assume it can be rebuilt.
- Secrets: `.p8` keys, `.backfill.env`, and `.dev.vars` stay gitignored. Worker secrets: `SLACK_WEBHOOK_URL`, `DASHBOARD_SECRET`, `CHAT_TOKEN`, `QUERY_TOKEN`, `CF_ANALYTICS_TOKEN`. The sales and analytics imports need the Finance-role Team key, not the In-App Purchase key `backfill.mjs` uses.
- Never add an Anthropic API key back to this project: it would move billing off Charlie's subscription.

## Settled: don't propose changing (decided-by-user)

Countdowns sends no notifications and that's accepted, not a bug to re-report (2026-08-10); it stays out of the CUSTOMER BASE panel (`CUSTOMER_BASE_EXCLUDE`). An app with no daily row in 30 days and no telemetry is left off the ACTIVE DEVICES panel (2026-08-25). The console runs on Claude Code, not the API (2026-08-09). Rationale is in `docs/analyst.md`, `docs/operations.md`, and `NOTES.md`.

## Analyst manual

@docs/analyst.md
