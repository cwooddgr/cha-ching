# cha-ching — notes

## Active users: Overflight's telemetry for MAU, Apple's reports for the rest

> **Author:** Claude Code (coder)
> **Date:** 2026-08-25
> **Status:** decided-by-user (Charlie asked for per-app MAU "as available", recalculated daily, with a 30-day trend graph, and pointed out mid-build that Overflight carries its own telemetry); the source split, table shapes and panel design below are proposed-by-agent

The dashboard's new ACTIVE DEVICES panel draws on two sources, and each row
says which:

**Overflight — telemetry.** Its app posts `session_start` per foreground with
a per-install random UUID to the Overflight Worker (Analytics Engine dataset
`overflight_app`). A daily cron in this Worker (`[triggers]`, 01:20 UTC;
`snapshotActiveUsers`) queries the AE SQL API and writes one row per UTC day
into `active_users`: distinct installs active in the 1 / 7 / 30 days ending
that day. That is a true rolling MAU over every install, recalculated daily,
and the panel's curve for Overflight is the rolling MAU itself. I snapshot
rather than query live because AE retains only three months and because the
dashboard must not spend AE queries per refresh. `*-debug` clients (dev
devices) are excluded; the series starts at the 2026-07-20 launch. First
snapshot: MAU 6,062 for the 30 days to 2026-08-24.

**Everything else — Apple's App Sessions report.** `scripts/analytics-import.mjs`
(daily launchd job, 10:15 and 18:15 local; same Finance-role key as the
sales import) pulls every instance of "App Sessions Standard" for each app
into `app_sessions`. ONGOING report requests already existed for all five App
Store apps when I looked (a Finance key can read them but not create them —
a new app needs an Admin key once). Apple gives distinct devices per day, per
Monday–Sunday week and per calendar month, so for these apps MAU is the
latest calendar month's figure, WAU the latest complete week's, DAU the
latest day's, and the curve is daily actives. I deliberately show no rolling
30-day number for them: Apple doesn't expose one (App Store Connect's "Active
in Last 30 Days" is UI-only) and summing daily uniques counts a daily user
thirty times — Overflight's week of 2026-08-10 summed to ~1,050 against
Apple's weekly distinct count of 506. Opt-in only, and Apple publishes a day
only with ≥5 contributing users, so thin apps have gaps rather than zeros.
Apple's daily count for Overflight runs at roughly a fifth of telemetry's
(2026-08-19: 208 vs 970), which is our first measurement of the opt-in rate.

Mechanics worth knowing: both tables are created by the Worker on first use
because `wrangler d1 execute --remote` 403s from the laptop (NOTES below,
2026-08-22); the Apple import honours "latest instance wins" per date so
re-runs and out-of-order instances are safe; the last five days of Apple
data are marked provisional (dimmed) per Apple's completeness window. The
analytics-read token in the `CF_ANALYTICS_TOKEN` secret is currently
itdept's `CF_READ_TOKEN` — the account pattern since 2026-08-07 is a
dedicated Account-Analytics-Read token per Worker, so a `cha-ching-analytics`
token should replace it when Charlie says so (needs `ITDEPT_CF_TOKENS_ADMIN`).


## Grace-period subscribers count as "retrying"

> **Author:** Claude Code (coder)
> **Date:** 2026-08-22
> **Status:** decided-by-user (Charlie asked that grace-period subscribers be counted as retrying rather than vanishing; the derivation below is proposed-by-agent)

Background: Charlie asked us to confirm that `DID_RENEW`/`BILLING_RECOVERY`
is treated like any renewal and that `DID_FAIL_TO_RENEW` /
`GRACE_PERIOD_EXPIRED` leave no stale "lapsed" flag. There is no flag to
leave: the Worker is append-only telemetry and subscriber standing is derived
at query time from the row with the furthest-out `expires_date`, so a
recovery (later expiry, real price) outranks the failure on its own. No
`DID_RENEW` query filters on subtype, so `BILLING_RECOVERY` already counted as
revenue, renewal, MRR and trial conversion. Verified against the six
Overflight trials that have hit billing retry (3 recovered, 2 grace-expired,
1 expired in retry).

The one gap was that a subscriber inside Apple's billing grace period —
period ended, charge failed, Apple still granting access while it retries —
dropped out of the CUSTOMER BASE headcount entirely. They now show as
`retrying`: the standing row is `DID_FAIL_TO_RENEW`/`GRACE_PERIOD` and
`renewalInfo.gracePeriodExpiresDate` (only in `raw`, read via
`json_extract`) is still in the future. Neither paying nor trialing, no MRR.
A `DID_FAIL_TO_RENEW` without the `GRACE_PERIOD` subtype grants no access and
stays expired. Counting rule recorded in `CLAUDE.md`; shipped as `b795f18`.

Gotcha when testing "as of" a past date: pinning `now` alone isn't enough,
because later recovery rows still win the ranking — also restrict
`signed_date <= then`. Done that way, 2026-08-20 shows the two subscribers
who were mid-grace that day.

## Slack celebrations when a window's gross crosses a whole $1,000

> **Author:** Claude Code (coder)
> **Date:** 2026-08-20
> **Status:** decided-by-user (Charlie asked for a celebratory notification any time we pass a whole-thousands-of-dollars gross threshold on any dashboard window; the detection design below is proposed-by-agent)

Whenever a Production revenue event pushes any of the dashboard's four
windows — 24h, 7d, 30d, all-time — past a whole-$1,000 line, the Worker posts
a gold "🎉 CHA-CHING — REVENUE MILESTONE" message to the same Slack webhook the
per-sale messages use, right after the sale's own message. The figure watched
is exactly the dashboard hero (`windows[key].total.revenue_usd`): estimated
gross from notifications, static FX, family-shared and free-trial rows
excluded.

Detection is stateless: at ingest we recompute each window's gross the way
`/api/stats` does, subtract the new event's own USD contribution to get the
before-value, and celebrate any $1,000 boundary between the two. I chose this
over a high-water-mark table because it handles rolling-window decay for free
— if the 7-day figure sags below a line and later re-crosses it, that
celebrates again, which is the literal reading of "any time we pass". A big
sale that jumps two lines celebrates once, at the higher line. Redelivered
notifications can't re-ring the bell: the check only runs when `INSERT OR
IGNORE` actually stored a new row. Backfill and sales-import paths never
trigger it.

At deploy time the windows stood at 24h $71 / 7d $233 / 30d $4,293 /
all-time $4,738 — so the first bells to ring will likely be all-time $5,000
(~$262 away) and 30d $5,000 (~$707 away).

## Dashboard renamed to rev-9000.dgrlabs.co

> **Author:** Claude Code (coder)
> **Date:** 2026-08-10
> **Status:** decided-by-user (Charlie asked for the rename; he also chose to have me make the Access change with netbot's token)

The console has been called REV-9000 on screen for a while; the URL now matches.
**Only the human-facing hostname moved** — the repo, the Worker, the D1
database and the workers.dev hostname all keep the cha-ching name, so Apple's
notification endpoint and the backfill/import scripts needed no changes.

The hazard here was ordering, not the rename. This Worker's entire auth model is
"serve the dashboard on exactly one hostname and trust that Cloudflare Access
sits in front of it" — there is no login of its own. The Access application
(`8031fe54-…`, "Cha-Ching Dashboard") listed **only** cha-ching.dgrlabs.co, with
no wildcard, so pointing `DASHBOARD_HOSTNAME` at a hostname Access didn't cover
would have published live revenue data to the internet.

Sequenced so no such window ever existed:

1. Attached rev-9000.dgrlabs.co as a Worker custom domain while
   `DASHBOARD_HOSTNAME` still said cha-ching. Verified the new name returned
   **404 on both `/` and `/api/stats`** — DNS and cert live, nothing served.
2. Added rev-9000.dgrlabs.co to the Access app's `self_hosted_domains` and
   `destinations`, keeping the old one. Verified both names then 302'd to
   Access unauthenticated, `/api/stats` included.
3. Only then flipped `DASHBOARD_HOSTNAME` and deployed.

Step 1 was belt-and-braces: even if step 2 had failed, the Worker would still
have refused to serve anything on the new name.

The Access edit went through `PUT`, not `PATCH` — Cloudflare answers PATCH on
that endpoint with `10405 Method not allowed for this authentication scheme`.
PUT replaces the whole object, so the body was built programmatically from a
fresh `GET` (saved at the time as a rollback) with the policy passed by id
reference rather than redefined. Confirmed afterwards that the allow policy,
the 730h session and the one-time-PIN IdP were all unchanged.

cha-ching.dgrlabs.co stays attached and inside the same Access app, redirecting
to the new name. **302, not 301**, deliberately: a permanent redirect sticks in
browser caches long after it stops being true and there is no SEO to protect on
a private dashboard.

Note for whoever reads this next: a stale browser cache made the old hostname
appear to still serve the dashboard after the flip, and a not-yet-propagated
deploy made the new one 404 once. Both were transient. Hard-reload before
believing either symptom.

The historical entries below still name cha-ching.dgrlabs.co. That is left
alone on purpose — they record what was true when written.

## The 85% proceeds assumption was wrong; the hero now uses measured rates

> **Author:** Claude Code (coder)
> **Date:** 2026-08-10
> **Status:** decided-by-user (Charlie asked what the sales import was buying, then chose this fix)

Charlie asked what the daily sales import was actually helping with. Checking
rather than answering from memory turned up a real error: **nothing is at 85%.**

| | gross | Apple's actual net | our 85% estimate | real rate |
|---|---|---|---|---|
| CD Wally | $664.73 | $514.96 | $565.02 | **77.5%** |
| Overflight | $3,417.41 | $2,799.49 | $2,904.79 | **81.9%** |

The small-business rate is the commission alone. Foreign storefronts also have
tax deducted before proceeds, so the true fraction is lower and varies with
where an app sells — CD Wally sells heavily outside the US and lands 7.5 points
under the assumption. Blended, we were inventing about **$155** of proceeds.

`/api/stats` now derives each app's effective rate from `sales`
(`SUM(units*proceeds_per_unit*fx) / SUM(units*customer_price*fx)`) and applies
it to that app's windowed gross, summing per app rather than putting one
blended rate on the total — the apps keep different fractions, so a blended
figure would drift as the mix between them shifts. An app with no sales history
(HeyMuso) falls back to the blended rate; the flat 85% survives only as a
constant used when `sales` is empty entirely.

The hero caption shows the rate beside the figure so the number explains itself
and a future drift is visible rather than buried. It shows the rate for the
**selected window's** actual mix — `proceeds_usd / revenue_usd` from the two
figures on screen — not `meta.proceeds_rate`, which is blended across all time.
I shipped the blended one first and caught it on the live page: the 7D window
is carried entirely by Overflight, so the caption claimed 81.2% next to an
81.9% division. An annotation that doesn't divide into the number beside it is
worse than no annotation.

This is still an estimate — a historical rate applied to a statically-FX'd
gross — but it is grounded in what Apple actually paid instead of a flat guess.
CLAUDE.md's revenue rules were updated too; they told the analyst agent to
assume 85%, which would have kept reproducing the error in chat answers.

## Sales reports imported; lifetime totals now come from Apple, not from us

> **Author:** Claude Code (coder)
> **Date:** 2026-08-10
> **Status:** decided-by-user (Charlie asked for pre-notification sales history and chose "authoritative for units + revenue" over gap-fill)

Charlie asked for the sales data older than the 180-day notification window so
lifetime totals would be accurate, and supplied a new App Store Connect **Team
key** (Finance role) for it. The existing `.p8` could not do this job: Apple
restricts In-App Purchase keys to the App Store Server API, and the Sales and
Finance endpoints additionally reject Individual keys.

**The history is shallower than expected, which made this easier.** Apple
returns NOT_FOUND for the 2024 and 2025 yearly reports: DGR Labs' first revenue
of any kind was **2026-02**. All of it therefore sits inside the one-year daily
retention window (verified: `2026-02-15` returns data, `2025-08-09` returns
`410 GONE`), so no yearly/monthly stitching was needed — 183 days of daily
Summary Sales reports, 4,973 rows, cover the entire business.

**What the gap actually was**, once imported:

| | notifications | sales reports |
|---|---|---|
| CD Wally unlocks | 23 / $465.56 gross | **31 / $664.73** |
| Countdowns unlocks | 0 | **4 / $24.14** |
| Overflight lifetime | 31 / $2,237.41 | 30 / $2,167.42 |

The Overflight row is the reassuring one: the single-unit difference is a
$69.99 purchase made *today*, and Apple's newest daily report is yesterday.
Where both sources are complete they agree to the cent, which is what made it
safe to treat the reports as authoritative.

**Design.** New `sales` table, one row per report line, plus `sales_import_log`
as the watermark. `/api/stats`'s lifetime-unlocks query now reads from `sales`
through the watermark and from `notifications` only after it — disjoint
stretches of time, so the union cannot double-count, and a sale made today
still reaches the dashboard immediately. The boundary is computed with `Intl`
against `America/Los_Angeles` rather than a hardcoded offset, because Apple
cuts its reports on Pacific time and that offset moves twice a year.

I kept rolling-window flow stats on `notifications`: they are about recent
activity, where notifications are complete and live, and the reports' one-day
lag would only blur them. `sales` owns units and revenue; `notifications` still
owns subscriber state, MRR and trial conversion, which aggregates cannot
answer at all — there are no transaction ids in a sales report.

The panel now shows Apple's real post-commission proceeds beside gross, so for
unlocks the 85% small-business estimate is gone. I also relabelled the unlock
rows' "codes" to "free": the reports lump offer codes together with press
copies, Friends-and-Family and other comps, and "codes" would have been too
narrow a word for what the number counts.

**Finding, closed as won't-fix: Countdowns sends us no notifications at all.**
It has real paid sales in the reports — including two in June 2026, well inside
the backfill window — and zero rows in `notifications`, so its App Store Server
Notifications V2 URL is almost certainly unset. Charlie's call: the revenue is
trivial (4 lifetime unlocks, $24.14) and not worth wiring up, and Countdowns
should come off the CUSTOMER BASE panel entirely. Done via
`CUSTOMER_BASE_EXCLUDE` in `src/index.js` — the sales rows stay in the table
and remain queryable, they just don't get a tile. **This is an accepted state,
not an open bug**; CLAUDE.md says so too, so a future session doesn't rediscover
it and file it as breakage.

**Scheduling** (Charlie asked for it, same session): a launchd agent runs the
importer **weekly**, Mondays at 10:00 local — 09:00 Pacific, after Apple's
"generally available by 8 a.m. PT". Verified end to end via `launchctl
kickstart`: exit 0, correctly found all 190 days already imported and fetched
nothing.

It started as a daily job until Charlie asked what the daily cadence was
actually buying, which was a fair challenge and mostly it wasn't. The panel
does not degrade between runs — the splice reads `notifications` for anything
newer than the last report we hold — so a week's gap costs a slightly-estimated
proceeds figure for those days and nothing else. Weekly it is.

I deliberately did **not** put this on a Cloudflare cron trigger. That would
mean moving the App Store Connect Finance-role key — which can read every sales
and financial report for the account — into Worker secrets, reversing this
project's standing choice to keep the `.p8` on Charlie's machine. The importer
skips days it already has and Apple retains daily reports for a year, so a run
missed while the Mac is asleep costs nothing. Robustness we don't need wasn't
worth the credential exposure.

Sales reports also cover **Flip Flap** and **Bezelbub**, which cha-ching has
never tracked, and carry free-download counts for everything — install volume
we have never had. Both left alone as out of scope.

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
`CF_ACCESS_TOKEN` API token that lives in the house repo's `.env`.

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
the ranch — see `house/bin/agent-bridge`), which runs Claude Code headless on
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
