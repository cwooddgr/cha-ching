# cha-ching — notes

## RESOLVED: Family Sharing copies were counted as revenue

> **Author:** Claude Code (coder)
> **Date:** 2026-08-03
> **Status:** decided-by-user (Charlie caught it and chose full exclusion; applied and deployed same day)

Charlie asked whether the revenue totals were counting Family Sharing
notifications. They were.

When a customer buys a Family Sharing–enabled product, Apple sends one extra
notification per family member with `inAppOwnershipType = FAMILY_SHARED` and the
**full product price** populated, even though that family member paid nothing —
Apple's own definition is "the transaction belongs to a family member who
benefits from service." The stats layer never looked at the column, so each
shared copy was added as a fresh sale.

Confirmed as duplication, not extra sales: grouping CD Wally's `ONE_TIME_CHARGE`
rows by `purchase_date` gives clean clusters of exactly 1 `PURCHASED` + N
`FAMILY_SHARED` sharing one purchase timestamp (1+4 three separate times, plus
smaller clusters). Each shared copy has its own `transaction_id` and no
`original_transaction_id` overlap with the purchaser, so no ID-based dedupe would
have caught it.

Impact, CD Wally lifetime: revenue $1,024.68 → **$465.56** (55% of it was
phantom), one-time purchases 56 → 25. Last 30 days: 11 events / $219.89 removed.
Overflight was unaffected — zero family-shared rows — so its figures and the
whole trial funnel (193 resolved / 23 converted) are unchanged, verified before
and after.

Fix: `in_app_ownership_type` added to the agg query's SELECT/GROUP BY, then
family-shared rows counted toward `events` only and skipped for revenue, refunds
and every purchase counter; the same exclusion added to both trial-conversion
subqueries and the three trial-start predicates (defensive — no family-shared
subscriptions exist yet, but Pro could become shareable); and a CRITICAL bullet
added to `CHAT_SYSTEM` so ad-hoc chat queries don't reintroduce it.

Worth carrying into the v2 Sales Reports work below: Apple's sales reports count
units the same way, so the fusion layer needs the same rule or it will disagree
with the notification layer.

## v2: fuse Sales Reports with notification estimates

> **Author:** Claude Code (planner)
> **Date:** 2026-08-03
> **Status:** decided-by-user (do this in v2) / proposed-by-agent (everything about *how*)

### The idea

Charlie's, in his words: pull data from Sales Reports too, and go back and replace
the App Store Server Notification versions of that data as it comes in, so the view
is always a fusion of realtime-but-estimated numbers and older-but-verified ones.

This retires three compromises v1 ships with, all currently disclosed in the UI as
estimates: the flat 85% proceeds assumption, the static `fx_rates` table, and the
"gross customer price, not accounting truth" caveat on every revenue figure.

### Verified before writing this (2026-08-03)

- **The existing API key works for the App Store Connect API.** `GET /v1/apps`
  returned 200 using `AuthKey_UPDLUA6UPB.p8` with the issuer/key IDs already in
  `.backfill.env` — signed the same way as `scripts/backfill.mjs` but with the
  `bid` claim omitted and `api.appstoreconnect.apple.com` as the host. No new
  credential needed. (I had expected this to be an In-App Purchase key, which
  would NOT have worked; Charlie was right that it's a team key with admin
  access. Tested, not assumed.)
- **`/v1/salesReports` is not yet proven to work.** A probe with a deliberately
  bogus `vendorNumber` returned 500 UNEXPECTED_ERROR rather than 401/403, which
  suggests auth passed and the failure was downstream — but that is inference,
  not confirmation. First build step is a real call with the real vendor number.

### Open input needed

- **Vendor number** — required by `/v1/salesReports`, and I could not find an
  endpoint that returns it. It lives in App Store Connect under the payments and
  financial reports area. Do NOT write click-steps for this from memory; verify
  the current path against Apple's own help docs at build time.

### Design constraints worth knowing up front

**1. Fusion belongs to the revenue layer only.** Notifications are an event stream
keyed by `original_transaction_id`. Sales reports are Apple's own aggregates, and
even the row-level ones (SUBSCRIBER / DETAILED) carry Apple's anonymized subscriber
IDs, which don't join to our transaction IDs. So verified data can overwrite money
totals, but the trial funnel we built in v1 — cohorts, resolution-anchored
conversion, the survival projection — has to stay notification-derived permanently.
Don't attempt fusion on the trial panel.

**2. It's three tiers, not two.** Instant estimate (notifications) → next-day
actuals (sales reports) → settled truth (finance reports, `/v1/financeReports`,
which lag roughly a month after period close). That argues for storing a
confidence level per period rather than a verified/unverified boolean.

**3. Separate table; never mutate `notifications`.** Add `sales_daily` (and later
`financials`). Revenue queries prefer the most-verified source that has rows for a
period and fall back to notification estimates. The raw Apple payloads stay
immutable as the audit trail.

**4. Show the seam.** A marker for "verified through <date>, estimated after" fits
the existing FUI vocabulary and keeps the mixed provenance honest rather than
hidden.

### Bonuses beyond verification

- **Recovers pre-horizon history.** Our notification data starts 2026-04-02, when
  the apps first pointed at cha-ching. Sales reports reach further back, so CD
  Wally's and Countdowns' earlier revenue becomes recoverable rather than lost.
- **Independent coverage check.** Sales data arrives regardless of whether an app's
  notification URL is configured — which would have caught the Countdowns gap below
  immediately, instead of it showing up as a suspicious zero.

### Report types available (from Apple's `/v1/salesReports` docs, 2026-08-03)

| reportType | subType | frequency | version |
| --- | --- | --- | --- |
| SALES | SUMMARY | DAILY, WEEKLY, MONTHLY, YEARLY | 1_0 |
| SUBSCRIPTION | SUMMARY | DAILY | 1_3 |
| SUBSCRIPTION_EVENT | SUMMARY | DAILY | 1_3 |
| SUBSCRIBER | DETAILED | DAILY | 1_3 |
| SUBSCRIPTION_OFFER_CODE_REDEMPTION | SUMMARY | DAILY | 1_0 |

Reports come back gzipped TSV. The offer-code report is directly relevant given
v1 now tracks code redemptions separately.

---

## RESOLVED: Countdowns sent no notifications

> **Author:** Claude Code (coder)
> **Date:** 2026-08-03
> **Status:** decided-by-user (Charlie authorized the fix; applied and verified same day)

The 180-day backfill returned zero Countdowns events. Confirmed the cause via
`GET /v1/apps` — `subscriptionStatusUrl` per app:

| App | notification URL |
| --- | --- |
| Overflight: Sky Radar | https://cha-ching.charlie-wood.workers.dev |
| CD Wally: Album Player | https://cha-ching.charlie-wood.workers.dev |
| Countdowns by DGR Labs | **(none)** |
| Bezelbub | (none) |
| Flip Flap by DGR Labs | (none) |
| HeyMuso | (none) |

Countdowns sells a paid upgrade, so its purchases and refunds were reaching
neither Slack nor D1.

**Fixed 2026-08-03** via `PATCH /v1/apps/6758349780`, mirroring CD Wally's exact
configuration — production and sandbox URLs both set to
`https://cha-ching.charlie-wood.workers.dev`, both at V2. Confirmed by re-reading
`GET /v1/apps` afterwards, not just by trusting the PATCH response.

**This is forward-only.** Apple's notification history contains only notifications
it actually attempted to send, so no amount of re-running `scripts/backfill.mjs`
will recover Countdowns' past activity — it was never sent anywhere. Historical
Countdowns revenue can only come from Sales Reports, which is one more argument
for the v2 work above. Nothing will appear in D1 until the next real Countdowns
purchase or refund.

Bezelbub, Flip Flap and HeyMuso remain unset. That may be correct — Flip Flap is
free and HeyMuso is unreleased — but it was not verified per app, so treat it as
an open question rather than a decision.

---

## 2026-08-07 — Dashboard moved behind Cloudflare Access

> **Author:** Claude Code (coder)
> **Date:** 2026-08-07
> **Status:** decided-by-user (moving the dashboard behind Access was Charlie's
> standing todo; hostname choice `cha-ching.dgrlabs.co` and implementation are
> mine, mirroring the house.dgrlabs.co pattern)

The dashboard now lives at **https://cha-ching.dgrlabs.co**, behind the DGR
Labs Zero Trust org (`dgrlabs.cloudflareaccess.com`, one-time PIN to
charlie.wood@gmail.com). Access app "Cha-Ching Dashboard"
(8031fe54-c1f6-4a0d-8166-f933a9a43a9d), policy de0a3cc1…, created via the
`CF_ACCESS_TOKEN` API token that lives in the netbot repo's `.env`.

Worker-side: dashboard assets and `/api/login|stats|pulse|chat` are refused
(404) off the custom hostname, and the custom hostname fails closed (503)
unless `ACCESS_ENABLED = "1"`. `POST /` (Apple ingest) and `POST /api/backfill`
(bearer) are untouched on workers.dev — App Store Connect still points at the
workers.dev URL for all apps; nothing to change there. The passphrase cookie
auth remains in force behind Access (belt and suspenders; first visit to the
new hostname asks for the passphrase once since the old cookie was scoped to
workers.dev). *(Superseded later the same day — see the entry below; the
passphrase layer was removed and Access is now the only gate.)*

Verified after ungating: unauth custom-domain request 302s to the Access
login; workers.dev serves 404 for `/` and `/api/stats`, 200 for an empty
ingest POST (no D1/Slack side effects), 401 for a bad backfill bearer.

Rollback: set `ACCESS_ENABLED = "0"` + redeploy (dashboard fails closed);
`DELETE access/apps/8031fe54…` removes the Access app; deleting the
`routes` block + redeploy drops the custom domain entirely.

---

## 2026-08-07 — Passphrase gate removed; Access is the only auth

> **Author:** Claude Code (coder)
> **Date:** 2026-08-07
> **Status:** decided-by-user (Charlie asked for option (a): strip the
> passphrase layer so cha-ching matches the netbot house dashboard, where
> Cloudflare Access is the sole gate)

Follow-up to the entry above, which left the old passphrase → cookie auth
stacked on top of Access — two logins for one dashboard. Now gone:

- `src/index.js`: dropped `POST /api/login`, `authCookie()`, `sha256Hex()`,
  the `cc_auth` cookie check, and the per-`/api/stats` cookie re-issue.
  `isAuthorized()` shrank to a bearer-token compare and is called from
  exactly one place — `POST /api/backfill`.
- `public/`: removed the auth-gate markup, its CSS, the login form handler,
  and the 401 → `showAuth()` branches. The page boots straight into the reel.

`DASHBOARD_SECRET` stays, now purely as the backfill bearer token — backfill
runs from a script against workers.dev, where Access can't sit in front of it.
`scripts/backfill.mjs` and `.backfill.env` are unchanged.

The dashboard's security now rests entirely on two worker-side checks that
were already there and are unchanged: hostname must be `cha-ching.dgrlabs.co`
(404 otherwise, so workers.dev can't serve data), and `ACCESS_ENABLED` must be
`"1"` (503 otherwise, so removing the Access app fails closed rather than open).

Rollback: `git revert` this commit — the passphrase path comes back intact and
`DASHBOARD_SECRET` still holds the same value.

**Global session, same day:** the DGR Labs Zero Trust org had no
`session_duration` set, so the global (SSO/identity) session was running on
Cloudflare's 24h default while both apps carried 730h app tokens. At Charlie's
request I set the org to `730h` to match, via
`PUT /accounts/85d08ef7…/access/organizations`. Read back and confirmed; no
other org field changed. Practical effect: one PIN now covers both
cha-ching.dgrlabs.co and house.dgrlabs.co for ~30 days, and a PIN prompt on
either one is a genuine 30-day lapse rather than a routine daily re-auth.

## The Analyst Console moved off the Anthropic API onto the Claude subscription

> **Author:** Claude Code (coder)
> **Date:** 2026-08-09
> **Status:** decided-by-user — Charlie, building the equivalent panel for the
> house dashboard: "I'd strongly prefer to use my subscription billing rather
> than API billing if that's possible." Then: "we should update cha-ching to
> use this design."

The console used to call the Anthropic API from inside the Worker — the SDK,
an `ANTHROPIC_API_KEY` secret, a `CHAT_SYSTEM` prompt and a `query_db` tool
bound to D1. That bills the API per token. A Claude subscription can only be
spent through Claude Code's OAuth credential, which is a file on a machine, so
the model call cannot happen at the edge.

It now proxies to **`agent-bridge`** on bigiron (the always-on Debian box at
the ranch — see `netbot/bin/agent-bridge`), which runs Claude Code headless on
Charlie's Max subscription. Reached over a Cloudflare tunnel; `/api/chat` is a
thin passthrough that adds a bearer token and streams the SSE back untouched.
The same daemon serves the house dashboard's chat panel on a separate profile.

Three consequences that matter for anyone editing this repo:

- **The counting rules moved into `CLAUDE.md` at the repo root**, because that
  is what Claude Code loads as context. They used to be the `CHAT_SYSTEM`
  string in `src/index.js`. If you change how a figure is counted, change it
  *there* — losing those rules is how Family Sharing inflates CD Wally's
  revenue from $466 to $1,025 again (see the first entry in this file).
- **The agent reads D1 through `POST /api/query`**, bearer-authenticated and
  reachable on workers.dev because a script on bigiron cannot clear Access.
  Going direct to Cloudflare's D1 API was rejected: there is no read-only D1
  scope, so that would have put a `D1:Edit` token — a write handle on
  production revenue data — in a file on the box. `scripts/ccq.mjs` is the
  client, and `agent-bridge` grants that profile exactly one Bash rule,
  `Bash(ccq *)`, so the SELECT-only guard in front of `/api/query` is the
  entire surface the analyst has.
- **`QUERY_TOKEN` is deliberately separate from `DASHBOARD_SECRET`** — reading
  the database and writing rows into it via backfill are different privileges.

The client now sends one message plus a session id instead of replaying the
whole transcript; continuity lives in Claude Code's session, which also keeps
the CLAUDE.md prefix warm in the prompt cache.

Verified live before shipping: per-app all-time revenue with Family Sharing
correctly excluded (CD Wally $465.56, matching the figure above), and the
SELECT-only guard refused all of DROP, comment-hidden DELETE, block-comment
hidden UPDATE, stacked statements and `WITH`-prefixed DELETE.

Rollback: `git revert` + `wrangler deploy`. The Worker would then need
`ANTHROPIC_API_KEY` back — which silently returns billing to the API, so do it
deliberately rather than as a reflex.
