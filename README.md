# Cha-Ching

A Cloudflare Worker that receives [App Store Server Notifications V2](https://developer.apple.com/documentation/AppStoreServerNotifications/App-Store-Server-Notifications-V2), stores every notification in D1, posts formatted messages to Slack, and serves an FUI-styled analytics dashboard with a built-in Claude analyst console.

```
Apple App Store ──(HTTPS POST, signed JWT)──> Cloudflare Worker ──┬──> D1 (every notification)
                                                                  └──> Slack #cha-ching (curated)

Dashboard (same worker, https://rev-9000.dgrlabs.co — behind Cloudflare Access):
  /            FUI dashboard — revenue, subscribers, trials, refunds (24h/7d/30d/all, per app)
  /api/stats   aggregates from D1
  /api/chat    proxies one turn to agent-bridge on bigiron (Claude Code), streamed via SSE
  /api/query   bearer-auth, workers.dev — the agent's SELECT-only window onto D1
```

**Two hostnames, strictly split** (since 2026-08-07): Apple's notification POSTs
and the backfill script target `cha-ching.charlie-wood.workers.dev`; humans use
`https://rev-9000.dgrlabs.co`, which sits behind Cloudflare Access (one-time
PIN, Zero Trust org `dgrlabs.cloudflareaccess.com` — same as house.dgrlabs.co).
The worker refuses dashboard/data routes on workers.dev (404) so Access can't
be bypassed, and fails closed (503) on the custom hostname if `ACCESS_ENABLED`
isn't `"1"`. Access is the **only** gate: the dashboard and its data endpoints
carry no app-level auth of their own (same arrangement as house.dgrlabs.co).

## Components

| Piece | Where | Notes |
|---|---|---|
| Ingest | `POST /` | Apple's notification endpoint. Persists **everything** (including Sandbox and Slack-suppressed types) to D1, then applies the existing Slack rules. |
| Backfill | `POST /api/backfill` | Bearer-authenticated; accepts `{signedPayloads: [...]}` and stores without Slacking. Fed by `scripts/backfill.mjs`. |
| Stats | `GET /api/stats` | Aggregates per window (24h/7d/30d/all) and per app: est. revenue (USD), refunds, new subs, trial starts/conversions, renewals, one-time buys, churn signals. |
| Chat | `POST /api/chat` | SSE stream. Proxies to `agent-bridge` on bigiron, which runs Claude Code on Charlie's **subscription** rather than the Anthropic API. No model call happens in this worker. |
| Query | `POST /api/query` | Bearer-authenticated, reachable on workers.dev because the agent is a script on bigiron and cannot clear Access. Single SELECT/WITH statements only — that guard is the only thing between an analytics console and a write handle. |
| Dashboard | `public/` | No build step. Served only on `rev-9000.dgrlabs.co` behind Cloudflare Access, which is the whole of its auth — no login screen, no cookie. |

**Revenue figures are estimates**: Apple's `price` field is the customer-facing price in local currency (milliunits). We convert with static FX rates (`fx_rates` table in `schema.sql`) and show estimated proceeds at 85% (small business program). Real proceeds live in App Store Connect.

## Setup

1. **Create the D1 database and schema:**
   ```sh
   npx wrangler d1 create cha-ching        # already done; id is in wrangler.toml
   npx wrangler d1 execute cha-ching --remote --file=schema.sql
   ```

2. **Secrets:**
   ```sh
   npx wrangler secret put SLACK_WEBHOOK_URL   # Slack incoming webhook
   npx wrangler secret put DASHBOARD_SECRET    # bearer token for /api/backfill
   npx wrangler secret put CHAT_TOKEN          # shared with agent-bridge on bigiron
   npx wrangler secret put QUERY_TOKEN         # for ccq on bigiron -> /api/query
   ```

3. **Deploy:**
   ```sh
   npm install && npx wrangler deploy
   ```

4. **Configure App Store Connect** (per app): App Information → App Store Server Notifications → set the Production and Sandbox URLs to the worker URL, Version 2 Notifications.

## Backfill (~180 days of history)

Apple's [Get Notification History](https://developer.apple.com/documentation/appstoreserverapi/get-notification-history) endpoint returns the past 180 days of notifications per app. The backfill script pages through it and uploads to `/api/backfill`. It needs an App Store Connect **In-App Purchase key** (`.p8`) — the key never leaves this machine.

Credentials live in `.backfill.env` at the repo root (gitignored; a placeholder file is created on clone — fill in `APPLE_ISSUER_ID`, `APPLE_KEY_ID`, `APPLE_KEY_PATH`, `CHA_CHING_URL`, `DASHBOARD_SECRET`). Then:

```sh
npm run backfill                      # all four apps; or: npm run backfill co.dgrlabs.overflight
```

Re-running is safe — rows are keyed by `notificationUUID` and duplicates are ignored.

## Local Development

Create a `.dev.vars` file:

```sh
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/YOUR/WEBHOOK/URL
DASHBOARD_SECRET=dev
CHAT_TOKEN=dev
QUERY_TOKEN=dev
```

Then:

```sh
npx wrangler d1 execute cha-ching --local --file=schema.sql
npx wrangler dev
```

### Test with curl

Build a mock JWS payload (header.payload.signature — only the payload matters since we decode without verification):

```sh
SIGNED=$(echo -n '{"typ":"JWT"}' | base64 | tr '+/' '-_' | tr -d '=')
BODY=$(echo -n '{"notificationType":"ONE_TIME_CHARGE","notificationUUID":"test-0001","signedDate":'$(date +%s000)',"data":{"environment":"Production","signedTransactionInfo":"eyJ0eXAiOiJKV1QifQ.'$(echo -n '{"bundleId":"co.dgrlabs.cdwally","productId":"cd_wally_unlock","transactionId":"2000000123456789","price":2990,"currency":"USD","storefront":"USA"}' | base64 | tr '+/' '-_' | tr -d '=')'.fakesig"}}' | base64 | tr '+/' '-_' | tr -d '=')

curl -X POST http://localhost:8787 \
  -H "Content-Type: application/json" \
  -d "{\"signedPayload\":\"${SIGNED}.${BODY}.fakesig\"}"
```

## Environment Variables / Secrets

| Name | Description |
|---|---|
| `SLACK_WEBHOOK_URL` | Slack incoming webhook URL |
| `DASHBOARD_SECRET` | Bearer token for `/api/backfill`. |
| `QUERY_TOKEN` | Bearer token for `/api/query`, held only by `ccq` on bigiron. Deliberately separate from `DASHBOARD_SECRET`: reading the database and writing rows into it are different privileges. |
| `CHAT_TOKEN` | Shared secret for `agent-bridge` on bigiron, which backs the analyst console. Must match `/etc/agent-bridge/config.json` there. |

## Notification Types → Slack

**Revenue events** (green, 💰): `SUBSCRIBED`, `DID_RENEW`, `OFFER_REDEEMED`, `ONE_TIME_CHARGE`

**Refund events** (red, ⚠️): `REFUND`, `REFUND_REVERSED`

**Informational events** (gray, ℹ️): everything else (renewal changes, billing failures, etc.)

**Dropped from Slack** (worker still returns 200 to Apple and **still stores the event in D1**):
- Sandbox notifications. Any that slip through the environment check would be tagged `[SANDBOX]`.
- `DID_CHANGE_RENEWAL_STATUS` with auto-renew turned off — a bummer, and not actionable.
- `EXPIRED` — by the time it lands, auto-renew was already off.
