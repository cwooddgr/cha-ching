# CLAUDE.md

Guidance for Claude Code working in this repo — and, just as importantly, the
operating context for the **analyst agent** behind rev-9000.dgrlabs.co's
ANALYST CONSOLE panel. That agent is Claude Code running on bigiron with this
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

## Reading the data

Query with **`ccq`**, which takes one SQL statement and returns JSON rows:

```
ccq "SELECT count(*) FROM notifications WHERE environment = 'Production'"
ccq --schema
```

It accepts a single `SELECT` or `WITH … SELECT` and refuses everything else —
comments stripped first, interior semicolons rejected, `WITH`-prefixed writes
keyword-screened. That is not a formality: it is the only thing between this
console and a write handle on production revenue data. Don't try to work
around it; if you genuinely need a write, that is a human's job with wrangler.

Results are capped at 200 rows. If you're hitting that, aggregate in SQL
rather than paging — it is both faster and less likely to be wrong.

Several queries are normal and usually better than one clever one.

## Schema

```sql
TABLE notifications (
  notification_uuid TEXT PRIMARY KEY,
  signed_date INTEGER,          -- ms since epoch, when Apple signed it
  notification_type TEXT,       -- SUBSCRIBED, DID_RENEW, ONE_TIME_CHARGE,
                                -- OFFER_REDEEMED, REFUND, EXPIRED,
                                -- DID_CHANGE_RENEWAL_STATUS, DID_FAIL_TO_RENEW, …
  subtype TEXT,                 -- INITIAL_BUY, RESUBSCRIBE, AUTO_RENEW_DISABLED,
                                -- BILLING_RETRY, VOLUNTARY, …
  bundle_id TEXT,               -- co.dgrlabs.{cdwally,countdowns,overflight,heymuso}
  environment TEXT,             -- 'Production' or 'Sandbox'
  product_id TEXT,
  transaction_id TEXT,
  original_transaction_id TEXT, -- subscription lineage: all events for one
                                -- subscriber share this
  price INTEGER,                -- MILLIUNITS of local currency (divide by 1000)
  currency TEXT,
  storefront TEXT,              -- alpha-3 country code
  offer_type INTEGER,           -- 1 intro, 2 promo, 3 offer code, 4 win-back
  offer_identifier TEXT,
  offer_discount_type TEXT,     -- 'FREE_TRIAL' | 'PAY_AS_YOU_GO' | 'PAY_UP_FRONT' | NULL
  in_app_ownership_type TEXT,   -- 'PURCHASED' | 'FAMILY_SHARED'
  purchase_date INTEGER,        -- ms since epoch
  expires_date INTEGER,         -- ms since epoch
  auto_renew_status INTEGER,    -- 0/1, from renewal info when present
  raw TEXT                      -- full decoded notification JSON
)

TABLE fx_rates (currency TEXT PRIMARY KEY, usd_rate REAL)  -- static, approximate

TABLE sales (                     -- Apple's DAILY Summary Sales reports
  report_date TEXT,               -- 'YYYY-MM-DD', Apple's PACIFIC-TIME day
  bundle_id TEXT,                 -- mapped from sku; NULL if unrecognised
  sku TEXT,                       -- the app's SKU, or the IAP's own
  product_type TEXT,              -- 'IA%' = the IAP/subscription rows
  units INTEGER,                  -- NEGATIVE on a refund
  proceeds_per_unit REAL,         -- Apple's ACTUAL post-commission figure, PER UNIT
  proceeds_currency TEXT,
  customer_price REAL,            -- per unit, gross, in customer_currency
  customer_currency TEXT,
  country_code TEXT,              -- alpha-2 (notifications.storefront is alpha-3)
  promo_code TEXT,                -- 'FREE' on a trial, else a code
  order_type TEXT,                -- 'Free Trial Intro Offer', an offer-code name, …
  subscription TEXT,              -- 'New' | 'Renewal'
  period TEXT,                    -- '7 Days' | '1 Month' | '1 Year'; NULL = one-time
  title, apple_identifier, parent_identifier, device, version,
  begin_date, end_date
)

TABLE sales_import_log (report_date TEXT PRIMARY KEY, imported_at INTEGER, row_count INTEGER)
```

**Always filter to `environment = 'Production'`** unless the question is
explicitly about sandbox.

## The apps

- **CD Wally** (`cdwally`) — one-time unlock.
- **Countdowns** (`countdowns`) — one-time unlock + subscription.
- **Overflight** (`overflight`) — subscription with a 7-day free trial;
  launched 2026-07-20. No immediate-buy option, so every organic start is a
  trial.
- **HeyMuso** (`heymuso`) — unreleased.

## Counting rules — the part that is easy to get wrong

**Revenue events**: `DID_RENEW`, `ONE_TIME_CHARGE`, and
`SUBSCRIBED`/`OFFER_REDEEMED` with subtype `INITIAL_BUY` or `RESUBSCRIBE` —
excluding rows where `offer_discount_type = 'FREE_TRIAL'` or `price = 0`.

⚠️ **ALWAYS exclude `in_app_ownership_type = 'FAMILY_SHARED'`** from any
revenue, purchase-count, or conversion query. Apple sends one extra
notification per family member when a shareable product is bought, carrying the
FULL product price even though that member paid nothing. They are the same
sale, duplicated: every cluster is exactly 1 `PURCHASED` + N `FAMILY_SHARED`
sharing one `purchase_date`. Counting them once inflated CD Wally's unlocks
from 23 to 56 and its revenue from $466 to $1,025. Include them only when the
question is explicitly about family-sharing reach.

**Estimated USD revenue**: `SUM(price * usd_rate) / 1000.0`, joining
`fx_rates` on `currency`. Every revenue figure from `notifications` is an
ESTIMATE of gross customer price — no Apple commission, static FX.

⚠️ **Don't use 85% for proceeds.** The small-business rate is the commission
alone; foreign storefronts also have tax taken off before proceeds, so the real
figure is lower and differs by app with its storefront mix. Measured from
Apple's own numbers on 2026-08-10: **CD Wally 77.5%, Overflight 81.9%, blended
81.2%** — assuming 85% invented ~$155 across the two. Derive the rate from
`sales` (`SUM(units*proceeds_per_unit*fx) / SUM(units*customer_price*fx)`)
rather than assuming one, and prefer `sales.proceeds_per_unit` outright when
the period is covered. `/api/stats` does this per app and reports the blended
rate as `meta.proceeds_rate`.

**Subscription starts** split three ways on `INITIAL_BUY`: free trial
(`offer_discount_type = 'FREE_TRIAL'`), offer-code redemption (`offer_type = 3`
— a promo code at a discount, **not** an organic paid signup), and organic
paid. Keep offer codes out of "new subscribers": they overstate both the count
and the revenue per subscriber. Overflight's only code so far is
`beta-thanks-2026` ($9.99 vs $19.99 yearly, launch week only).

**Paying subscribers (headcount, not flow)** — one subscriber is one
`original_transaction_id`; their current standing is the row with the furthest-
out `expires_date` (ties broken by `signed_date`, so a mid-period
`AUTO_RENEW_DISABLED` wins over the `DID_RENEW` it shares an end date with).
They are a paying subscriber if that row has `expires_date > now`, `price > 0`,
and `offer_discount_type != 'FREE_TRIAL'`. Their plan is that row's
`product_id`, so a plan change follows them.

⚠️ A running free trial is **not** a paying subscriber — it is the pipeline.
Report it separately as trialing. Someone who has switched auto-renew off *is*
still paying (they bought the period they are in) but is lapsing: count them in
the headcount and exclude them from any forward-looking run rate.

**Retrying (billing grace period)** — a subscriber whose standing row is
`DID_FAIL_TO_RENEW` with subtype `GRACE_PERIOD` and whose grace window
(`json_extract(raw, '$.renewalInfo.gracePeriodExpiresDate')`, ms epoch) is
still open. Their period has ended and the charge failed, but Apple is still
granting access while it retries the card. Report them as **retrying**:
neither paying nor trialing, no MRR — access without revenue. There is no
flag to maintain: a `DID_RENEW`/`BILLING_RECOVERY` outranks the grace row on
`expires_date` (count it exactly like any renewal), and `GRACE_PERIOD_EXPIRED`
or `EXPIRED`/`BILLING_RETRY` outranks it on `signed_date`. A
`DID_FAIL_TO_RENEW` *without* the `GRACE_PERIOD` subtype means no grace was
granted — that subscriber is simply expired until a recovery arrives.

This is **state, not a window** — "who is subscribed right now" must not move
when the time window changes.

**Lifetime unlocks are owners, not subscribers.** Overflight's `lifetime.v2`
($69.99) and CD Wally's wallets. They never renew and contribute **no MRR**;
never divide one over an assumed lifespan to manufacture one. Count them
separately.

⚠️ **Count unlocks from `sales`, not from `notifications`.** Notification
history reaches back only 180 days, which hides 8 of CD Wally's unlocks and
**all** of Countdowns' behind the cliff. In `sales` they are
`product_type LIKE 'IA%' AND period IS NULL`; refunds are negative units, so
`SUM(units)` nets them out on its own. `notifications` still covers the day or
so since Apple's newest report — that seam is what `/api/stats` splices, and a
question about "today" has to come from `notifications` alone.

**MRR** — each paying subscriber normalised to a month from **their own**
period length, never from the product id: `price * usd_rate * 30.44 /
((expires_date - purchase_date) / 86400000.0)`, summed (30.44 = 365.25/12).
ARR is MRR × 12. Report the lapsing slice separately as at-risk MRR rather
than netting it out — it is this month's revenue and next month's churn.

⚠️ **Count one period per subscriber, not one per transaction.** Apple bills
~8h before a cycle ends, so a renewal's period overlaps the one it replaces;
summing every paid period double-counts everyone mid-renewal. For MRR at a
past date, take each subscriber's most recent period paid for by then and
count it only if it had not yet expired.

Offer-code subscribers depress MRR while their discounted term runs
(`beta-thanks-2026` is $9.99 against a $19.99 list) and will step up at
renewal. Say so if MRR-per-subscriber is the question.

**Trial conversion** — a later paid revenue event with the same
`original_transaction_id`.

⚠️ **Measure conversion over RESOLVED trials only** — those whose
`expires_date` has passed. A trial still inside its period has not had the
chance to convert and must never count as a failure; report those separately as
pending. Rate = converted / resolved, never converted / all starts, which
understates it badly while an app is young.

**Do not add cancellations to the denominator.** Cancelling mid-trial
(`DID_CHANGE_RENEWAL_STATUS` / `AUTO_RENEW_DISABLED`) is the *reason* a trial
later fails to convert, not a separate outcome — the same person would be
counted twice. Cancellation among in-flight trials is a useful leading
indicator of where the rate is heading; report it as that.

**No settle grace is needed.** Apple bills in advance, so `DID_RENEW` arrives
~8 hours BEFORE the trial's `expires_date`. Billing retry
(`DID_FAIL_TO_RENEW`) is the rare exception where a verdict lands late.

**History depth**: `notifications` goes back ~180 days before 2026-08 (Apple's
notification-history limit) — don't report a trend that starts at that cliff.
`sales` has no such cliff for our purposes: DGR Labs' **first revenue of any
kind was 2026-02**, and Apple returns NOT_FOUND for every earlier report, so
the sales table holds the complete history of the business.

## The sales table — counting rules

Imported by `scripts/sales-import.mjs`; re-runnable, and each day is replaced
rather than appended so restatements land cleanly.

- **Money rows are `product_type LIKE 'IA%'`.** Everything else is app
  downloads, updates and re-downloads: real unit counts, but never revenue.
  (This is also the only install-volume data we have.)
- **`proceeds_per_unit` is PER UNIT.** Multiply by `units`. It is Apple's
  actual post-commission figure — **do not** apply the 85% small-business
  factor to it, that is already done. `customer_price` is the gross the
  customer paid; the 85% estimate applies only to `notifications`.
- **Paid vs free**: `proceeds_per_unit > 0` is a real sale. Zero-proceeds IAP
  rows are free trials (`order_type = 'Free Trial Intro Offer'`), comps
  (`Press`, `Friends and Family`, `thankyou`, `lifetime-free`) and 100% offer
  codes. Two currency joins, not one: `customer_currency` for gross,
  `proceeds_currency` for net.
- **Refunds are negative `units`** against the original sale's date. Never
  filter them out — summing is what nets them.
- **`report_date` is Pacific Time; `signed_date` is UTC.** Never join the two
  tables on a date, and never assume a day lines up across them.
- **The reports lag a day.** The newest is yesterday PT; `sales_import_log`
  holds the watermark. Today's activity exists only in `notifications`.
- **There are no transaction ids.** Subscriber state, MRR and trial conversion
  cannot be answered from here — those stay with `notifications`, which is why
  both tables exist.
- **It covers the whole account**, including Flip Flap and Bezelbub, which
  send us no notifications at all. Filter on `bundle_id` unless the question
  is genuinely account-wide.

**Countdowns sends us no notifications, and that is fine** (found 2026-08-10;
Charlie's call the same day). Its V2 notification URL is almost certainly unset
in App Store Connect, but at four lifetime unlocks the revenue isn't worth
wiring up, so this is a known accepted state — **not a bug to re-report every
session**. Consequences: any Countdowns figure comes from `sales`, no
Countdowns subscription state exists, and it is deliberately excluded from the
CUSTOMER BASE panel (`CUSTOMER_BASE_EXCLUDE` in `src/index.js`) while staying
fully queryable in `sales`.

**Time**: use SQLite date functions against ms epochs, e.g.
`signed_date >= unixepoch('now', '-7 days') * 1000`.

## Answering style

Tight and quantitative — this panel is a heads-up display, not a report. Plain
prose or compact markdown tables. Round money to cents. Say when a figure is an
estimate, and say when a sample is too small to carry the conclusion you are
being asked for.

## Working on the code (not the data)

- `src/index.js` — the whole Worker: ingest, Slack, stats, the analyst
  endpoints. `public/` is the dashboard (no build step).
- `scripts/sales-import.mjs` — pulls Apple's daily sales reports into `sales`.
  Needs an App Store Connect **Team key** with the Finance role (NOT the
  In-App Purchase key `backfill.mjs` uses — Apple restricts that one to the
  App Store Server API). Both `.p8` files and `.backfill.env` are gitignored.
  Re-run any time; it skips days already imported. Runs **weekly** (Mondays,
  10:00 local) via the launchd agent in
  `scripts/co.dgrlabs.cha-ching.sales-import.plist`
  (install instructions in the file; log at
  `~/Library/Logs/cha-ching-sales-import.log`). A run missed while the Mac is
  asleep costs nothing — the next one backfills it.
- Deploy: `npx wrangler deploy`. Secrets: `SLACK_WEBHOOK_URL`,
  `DASHBOARD_SECRET`, `CHAT_TOKEN`.
- The console's chat proxies to `agent-bridge` on bigiron; there is no
  Anthropic API key in this project any more, and adding one back would move
  billing off Charlie's subscription.
