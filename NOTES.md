# cha-ching — notes

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

## Open item: Countdowns sends no notifications

> **Author:** Claude Code (coder)
> **Date:** 2026-08-03
> **Status:** proposed-by-agent (finding is verified; the fix is not yet authorized)

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

Countdowns sells a paid upgrade, so its purchases and refunds currently reach
neither Slack nor D1. Bezelbub, Flip Flap and HeyMuso may legitimately not need
one — worth confirming per app rather than assuming.

This is fixable over the API (`PATCH /v1/apps/{id}`, setting
`subscriptionStatusUrl` and `subscriptionStatusUrlVersion`) rather than through
the App Store Connect UI, but it changes live production app configuration and
needs Charlie's explicit go-ahead first.
