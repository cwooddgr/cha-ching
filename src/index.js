// cha-ching: App Store Server Notifications V2 → D1 + Slack, with an FUI
// dashboard and a Claude analyst console over the stored data.
//
// The console no longer calls the Anthropic API from here. It proxies to
// agent-bridge on bigiron, which runs Claude Code on Charlie's subscription
// (decided-by-user 2026-08-09) — the same brain the house dashboard's CMD
// panel talks to, on a different profile. See netbot/bin/agent-bridge.
//
// Two consequences worth knowing before editing this file:
//   * The analyst's knowledge — schema, and the counting rules that make the
//     numbers correct — moved OUT of a system-prompt constant here and into
//     CLAUDE.md at the root of this repo, because that is what Claude Code
//     loads as context. If you change how a figure should be counted, change
//     it there. Losing those rules is how you get revenue inflated by
//     FAMILY_SHARED duplicates again.
//   * The agent reads D1 through /api/query below, not through a binding. The
//     SELECT-only guard that used to sit in front of the chat tool now sits in
//     front of that endpoint, and it is the only thing standing between an
//     analytics console and a write handle.

const APP_NAMES = {
  "co.dgrlabs.cdwally": "CD Wally",
  "co.dgrlabs.countdowns": "Countdowns",
  "co.dgrlabs.heymuso": "HeyMuso",
  "co.dgrlabs.overflight": "Overflight",
};

const REVENUE_EVENTS = new Set([
  "SUBSCRIBED:INITIAL_BUY",
  "SUBSCRIBED:RESUBSCRIBE",
  "DID_RENEW",
  "OFFER_REDEEMED:INITIAL_BUY",
  "OFFER_REDEEMED:RESUBSCRIBE",
  "ONE_TIME_CHARGE",
]);

const REFUND_EVENTS = new Set([
  "REFUND",
  "REFUND_REVERSED",
]);

const OFFER_TYPES = {
  1: "Introductory offer",
  2: "Promotional offer",
  3: "Offer code",
  4: "Win-back offer",
};

const EVENT_DESCRIPTIONS = {
  SUBSCRIBED: { INITIAL_BUY: "New Subscription", RESUBSCRIBE: "Resubscribed" },
  DID_RENEW: { _: "Subscription Renewed" },
  OFFER_REDEEMED: { INITIAL_BUY: "New Purchase via Offer", RESUBSCRIBE: "Resubscribed via Offer" },
  ONE_TIME_CHARGE: { _: "New Purchase" },
  DID_CHANGE_RENEWAL_STATUS: {
    AUTO_RENEW_ENABLED: "Auto-Renew Turned On",
    AUTO_RENEW_DISABLED: "Auto-Renew Turned Off",
    _: "Renewal Status Changed",
  },
  DID_CHANGE_RENEWAL_PREF: { _: "Subscription Plan Changed" },
  DID_FAIL_TO_RENEW: { _: "Renewal Failed" },
  EXPIRED: { _: "Subscription Expired" },
  GRACE_PERIOD_EXPIRED: { _: "Grace Period Expired" },
  PRICE_INCREASE: { _: "Price Increase" },
  REFUND: { _: "Refund" },
  REFUND_DECLINED: { _: "Refund Declined" },
  REFUND_REVERSED: { _: "Refund Reversed" },
  REVOKE: { _: "Family Sharing Revoked" },
  CONSUMPTION_REQUEST: { _: "Consumption Info Requested" },
  RENEWAL_EXTENDED: { _: "Renewal Extended" },
  RENEWAL_EXTENSION: { _: "Renewal Extension" },
  EXTERNAL_PURCHASE_TOKEN: { _: "External Purchase Token" },
  TEST: { _: "Test Notification" },
};

// ISO 3166-1 alpha-3 → alpha-2 for common App Store storefronts
const ALPHA3_TO_ALPHA2 = {
  USA: "US", GBR: "GB", CAN: "CA", AUS: "AU", DEU: "DE", FRA: "FR", JPN: "JP",
  KOR: "KR", CHN: "CN", IND: "IN", BRA: "BR", MEX: "MX", ITA: "IT", ESP: "ES",
  NLD: "NL", RUS: "RU", TUR: "TR", SAU: "SA", ARE: "AE", SGP: "SG", HKG: "HK",
  TWN: "TW", THA: "TH", IDN: "ID", MYS: "MY", PHL: "PH", VNM: "VN", NZL: "NZ",
  ZAF: "ZA", SWE: "SE", NOR: "NO", DNK: "DK", FIN: "FI", POL: "PL", CHE: "CH",
  AUT: "AT", BEL: "BE", IRL: "IE", PRT: "PT", CZE: "CZ", ROU: "RO", HUN: "HU",
  ISR: "IL", EGY: "EG", CHL: "CL", COL: "CO", ARG: "AR", PER: "PE", UKR: "UA",
  PAK: "PK", BGD: "BD", NGA: "NG", KEN: "KE", GHA: "GH", LKA: "LK", MMR: "MM",
  KHM: "KH", LAO: "LA", NPL: "NP", QAT: "QA", KWT: "KW", OMN: "OM", BHR: "BH",
  JOR: "JO", LBN: "LB", GRC: "GR", BGR: "BG", HRV: "HR", SVK: "SK", SVN: "SI",
  LTU: "LT", LVA: "LV", EST: "EE", LUX: "LU", MLT: "MT", CYP: "CY", ISL: "IS",
};

function decodeJWSPayload(jws) {
  const parts = jws.split(".");
  if (parts.length !== 3) throw new Error("Invalid JWS: expected 3 parts");
  const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  return JSON.parse(atob(padded));
}

function countryFlag(alpha3) {
  const alpha2 = ALPHA3_TO_ALPHA2[alpha3];
  if (!alpha2) return "";
  return String.fromCodePoint(
    ...[...alpha2].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65)
  );
}

function formatPrice(price, currency) {
  if (price == null || currency == null) return null;
  const amount = (price / 1000).toFixed(2);
  return `${amount} ${currency}`;
}

function eventKey(type, subtype) {
  return subtype ? `${type}:${subtype}` : type;
}

function describeEvent(type, subtype) {
  const entry = EVENT_DESCRIPTIONS[type];
  if (!entry) return type;
  return entry[subtype] || entry._ || type;
}

function appName(bundleId) {
  return APP_NAMES[bundleId] || bundleId || "Unknown App";
}

// ---------------------------------------------------------------------------
// Slack (unchanged behavior)
// ---------------------------------------------------------------------------

function buildSlackMessage(notification, transaction, renewalInfo) {
  const { notificationType, subtype, data } = notification;
  const isSandbox = data?.environment === "Sandbox";
  const key = eventKey(notificationType, subtype);
  const isRevenue = REVENUE_EVENTS.has(key);
  const isRefund = REFUND_EVENTS.has(notificationType);
  const name = appName(transaction?.bundleId);
  let description = describeEvent(notificationType, subtype);

  // DID_CHANGE_RENEWAL_STATUS sometimes arrives without a subtype; the
  // renewal info's autoRenewStatus (0 = off, 1 = on) carries the direction.
  if (
    notificationType === "DID_CHANGE_RENEWAL_STATUS" &&
    !subtype &&
    renewalInfo?.autoRenewStatus != null
  ) {
    description = renewalInfo.autoRenewStatus === 1 ? "Auto-Renew Turned On" : "Auto-Renew Turned Off";
  }

  let emoji, color;
  if (isRevenue) {
    emoji = "\u{1F4B0}"; // 💰
    color = "#2eb67d";
  } else if (isRefund) {
    emoji = "⚠️"; // ⚠️
    color = "#e01e5a";
  } else {
    emoji = "ℹ️"; // ℹ️
    color = "#cccccc";
  }

  const sandboxTag = isSandbox ? " [SANDBOX]" : "";
  const familyTag = transaction?.inAppOwnershipType === "FAMILY_SHARED" ? " (Family Shared)" : "";
  const title = `${emoji} ${name} — ${description}${familyTag}${sandboxTag}`;
  const lines = [];

  if (transaction) {
    const price = formatPrice(transaction.price, transaction.currency);
    const flag = countryFlag(transaction.storefront);
    if (transaction.offerDiscountType === "FREE_TRIAL") {
      lines.push(flag ? `Free trial ${flag}` : "Free trial");
    } else if (price) {
      lines.push(flag ? `${price} ${flag}` : price);
    }
    if (transaction.productId) {
      lines.push(`Product: ${transaction.productId}`);
    }
    const offerName = OFFER_TYPES[transaction.offerType];
    if (transaction.offerIdentifier) {
      lines.push(`Offer: ${transaction.offerIdentifier}${offerName ? ` (${offerName})` : ""}`);
    } else if (offerName) {
      lines.push(`Offer: ${offerName}`);
    } else if (transaction.offerType != null) {
      lines.push(`Offer type: ${transaction.offerType}`);
    }
    if (transaction.transactionId) {
      lines.push(`Transaction: ${transaction.transactionId}`);
    }
  }

  const subtypeInDescription = EVENT_DESCRIPTIONS[notificationType]?.[subtype] != null;
  if (!isRevenue && !isRefund && subtype && !subtypeInDescription) {
    lines.push(`Subtype: ${subtype}`);
  }

  return {
    attachments: [
      {
        color,
        fallback: title,
        blocks: [
          {
            type: "section",
            text: { type: "mrkdwn", text: `*${title}*${lines.length ? "\n" + lines.join("\n") : ""}` },
          },
        ],
      },
    ],
  };
}

async function postToSlack(webhookUrl, message) {
  const resp = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(message),
  });
  if (!resp.ok) {
    throw new Error(`Slack responded ${resp.status}: ${await resp.text()}`);
  }
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function decodeNotification(signedPayload) {
  const notification = decodeJWSPayload(signedPayload);

  let transaction = null;
  if (notification.data?.signedTransactionInfo) {
    try {
      transaction = decodeJWSPayload(notification.data.signedTransactionInfo);
    } catch (e) {
      console.error("Failed to decode signedTransactionInfo:", e);
    }
  }

  let renewalInfo = null;
  if (notification.data?.signedRenewalInfo) {
    try {
      renewalInfo = decodeJWSPayload(notification.data.signedRenewalInfo);
    } catch (e) {
      console.error("Failed to decode signedRenewalInfo:", e);
    }
  }

  return { notification, transaction, renewalInfo };
}

function persistStatement(db, { notification, transaction, renewalInfo }) {
  const raw = {
    notification: { ...notification, data: { ...notification.data } },
    transaction,
    renewalInfo,
  };
  // The signed blobs are redundant once decoded; drop them to keep rows small.
  delete raw.notification.data.signedTransactionInfo;
  delete raw.notification.data.signedRenewalInfo;

  return db
    .prepare(
      `INSERT OR IGNORE INTO notifications (
        notification_uuid, signed_date, notification_type, subtype, bundle_id,
        environment, product_id, transaction_id, original_transaction_id,
        price, currency, storefront, offer_type, offer_identifier,
        offer_discount_type, in_app_ownership_type, purchase_date, expires_date,
        auto_renew_status, raw
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      notification.notificationUUID || crypto.randomUUID(),
      notification.signedDate ?? Date.now(),
      notification.notificationType,
      notification.subtype ?? null,
      transaction?.bundleId ?? notification.data?.bundleId ?? null,
      notification.data?.environment ?? null,
      transaction?.productId ?? null,
      transaction?.transactionId ?? null,
      transaction?.originalTransactionId ?? null,
      transaction?.price ?? null,
      transaction?.currency ?? null,
      transaction?.storefront ?? null,
      transaction?.offerType ?? null,
      transaction?.offerIdentifier ?? null,
      transaction?.offerDiscountType ?? null,
      transaction?.inAppOwnershipType ?? null,
      transaction?.purchaseDate ?? null,
      transaction?.expiresDate ?? null,
      renewalInfo?.autoRenewStatus ?? null,
      JSON.stringify(raw)
    );
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

// Humans are authenticated by Cloudflare Access in front of
// cha-ching.dgrlabs.co, not here — the dashboard and its data endpoints carry
// no app-level auth of their own (same arrangement as house.dgrlabs.co).
// DASHBOARD_SECRET survives only as the bearer token for /api/backfill, which
// runs from a script against workers.dev where Access can't reach.
function isAuthorized(request, env) {
  if (!env.DASHBOARD_SECRET) return false;
  return request.headers.get("Authorization") === `Bearer ${env.DASHBOARD_SECRET}`;
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

const WINDOWS = {
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
  all: null,
};

// Where the trial conversion rate is heading, once every trial running today
// has resolved.
//
// The naive projection — "uncancelled trials will convert at the rate
// uncancelled trials historically convert" — reads high, because cancellation
// is heavily front-loaded (most cancels land on day 0) and the pending pool is
// mostly trials that just started. Assuming a day-0 trial is as safe as a
// day-6 trial repeats, one level up, the same mistake as counting in-flight
// trials as failures.
//
// So: build a per-day cancellation hazard from trials that have already
// resolved, then condition each in-flight trial on how far it has actually
// got. Everything is derived from the data — nothing is hardcoded — so the
// model sharpens on its own as trials accumulate.
const HAZARD_BUCKETS = 7; // fractions of a trial, not days, so any length works

function projectTrials(rows, now) {
  // A trial that has already been billed is decided, even with hours left on
  // the clock — Apple charges ~8h before expiry. Leaving it in the in-flight
  // pool would have the model assign a probability to a known outcome, and
  // drag the projection down with it.
  const resolved = (r) => r.trial_end <= now || r.converted;
  const matured = rows.filter(resolved);
  const inFlight = rows.filter((r) => !resolved(r));
  const bucketOf = (r, at) => {
    const span = r.trial_end - r.start;
    if (span <= 0) return 0;
    const b = Math.floor(((at - r.start) / span) * HAZARD_BUCKETS);
    return Math.max(0, Math.min(HAZARD_BUCKETS - 1, b));
  };
  const cancelledInTrial = (r) => r.cancel_at != null && r.cancel_at < r.trial_end;

  // Outcome rates by cancellation status, from resolved trials.
  const settled = { yes: { n: 0, conv: 0 }, no: { n: 0, conv: 0 } };
  for (const r of matured) {
    const bucket = settled[cancelledInTrial(r) ? "yes" : "no"];
    bucket.n += 1;
    bucket.conv += r.converted ? 1 : 0;
  }
  if (!matured.length || !settled.no.n) return null;
  const pConvClean = settled.no.conv / settled.no.n;
  const pConvCancelled = settled.yes.n ? settled.yes.conv / settled.yes.n : 0;

  // Cancellation hazard: of the trials still alive entering each bucket, how
  // many cancelled in it. Survivors carry forward.
  const cancels = new Array(HAZARD_BUCKETS).fill(0);
  for (const r of matured) {
    if (cancelledInTrial(r)) cancels[bucketOf(r, r.cancel_at)] += 1;
  }
  // atRisk[b] = trials that reached bucket b without cancelling.
  const atRisk = new Array(HAZARD_BUCKETS).fill(0);
  let alive = matured.length;
  for (let b = 0; b < HAZARD_BUCKETS; b += 1) {
    atRisk[b] = alive;
    alive -= cancels[b];
  }
  // Probability a trial that has survived through bucket b cancels before it ends.
  const cancelsAfter = (b) => {
    let remaining = 0;
    for (let i = b + 1; i < HAZARD_BUCKETS; i += 1) remaining += cancels[i];
    const survivors = atRisk[b] - cancels[b];
    return survivors > 0 ? remaining / survivors : 0;
  };

  let expected = matured.reduce((sum, r) => sum + (r.converted ? 1 : 0), 0);
  for (const r of inFlight) {
    if (r.cancel_at != null) {
      expected += pConvCancelled;
    } else {
      const pCancelLater = cancelsAfter(bucketOf(r, now));
      expected += (1 - pCancelLater) * pConvClean + pCancelLater * pConvCancelled;
    }
  }

  const total = rows.length;
  return total > 0 ? { rate: expected / total, trials: total } : null;
}

async function handleStats(env) {
  const now = Date.now();
  const statements = [];
  const keys = [];

  for (const [key, span] of Object.entries(WINDOWS)) {
    const since = span == null ? 0 : now - span;
    keys.push(`agg:${key}`);
    statements.push(
      env.DB.prepare(
        `SELECT bundle_id, notification_type, subtype, offer_discount_type, offer_type,
                in_app_ownership_type,
                COUNT(*) AS n,
                SUM(CASE WHEN price IS NOT NULL AND usd_rate IS NOT NULL THEN price * usd_rate ELSE 0 END) AS usd_millis,
                SUM(CASE WHEN price IS NOT NULL AND price > 0 AND usd_rate IS NULL THEN 1 ELSE 0 END) AS unknown_fx
         FROM notifications LEFT JOIN fx_rates USING (currency)
         WHERE environment = 'Production' AND signed_date >= ?
         GROUP BY bundle_id, notification_type, subtype, offer_discount_type, offer_type,
                  in_app_ownership_type`
      ).bind(since)
    );
    // Trial outcomes, anchored on RESOLUTION (the trial's own end date), not on
    // the start date and not on the arrival of an EXPIRED notification.
    //
    // A trial has exactly one terminal outcome, decided when its trial period
    // ends: it either renewed into a paid subscription or it didn't. Cancelling
    // mid-trial is a *reason* for the latter, not a separate outcome — counting
    // it separately would double-count the same person (every EXPIRED trial in
    // our data also has an AUTO_RENEW_DISABLED).
    //
    // No settle grace is applied: Apple bills in advance, so DID_RENEW lands
    // ~8h BEFORE expires_date. By the time a trial resolves the verdict is
    // already in hand. (Billing retry is the rare exception — those read as
    // unconverted until the retry succeeds, then correct themselves, since
    // every load recomputes from raw notifications.)
    keys.push(`trial:${key}`);
    statements.push(
      env.DB.prepare(
        `SELECT t.bundle_id,
                COUNT(*) AS resolved,
                SUM(CASE WHEN pay.oid IS NOT NULL THEN 1 ELSE 0 END) AS converted,
                SUM(CASE WHEN pay.oid IS NOT NULL AND pay.usd_rate IS NOT NULL
                         THEN pay.price * pay.usd_rate ELSE 0 END) AS usd_millis
         FROM notifications t
         LEFT JOIN (
           -- MIN(signed_date) with bare columns: SQLite takes price/usd_rate from
           -- the matching row, so this is the FIRST paid event (the conversion),
           -- not the sum of every later renewal.
           SELECT p.original_transaction_id AS oid,
                  MIN(p.signed_date) AS first_paid,
                  p.price AS price, fx.usd_rate AS usd_rate
           FROM notifications p LEFT JOIN fx_rates fx ON fx.currency = p.currency
           WHERE p.price > 0
             AND (p.in_app_ownership_type IS NULL OR p.in_app_ownership_type != 'FAMILY_SHARED')
             AND (p.offer_discount_type IS NULL OR p.offer_discount_type != 'FREE_TRIAL')
             AND (p.notification_type IN ('DID_RENEW', 'ONE_TIME_CHARGE')
                  OR (p.notification_type IN ('SUBSCRIBED', 'OFFER_REDEEMED')
                      AND p.subtype IN ('INITIAL_BUY', 'RESUBSCRIBE')))
           GROUP BY p.original_transaction_id
         ) pay ON pay.oid = t.original_transaction_id AND pay.first_paid > t.signed_date
         WHERE t.environment = 'Production'
           AND t.offer_discount_type = 'FREE_TRIAL' AND t.subtype = 'INITIAL_BUY'
           AND (t.in_app_ownership_type IS NULL OR t.in_app_ownership_type != 'FAMILY_SHARED')
           AND t.expires_date IS NOT NULL
           AND t.expires_date <= ? AND t.expires_date >= ?
         GROUP BY t.bundle_id`
      ).bind(now, since)
    );
  }

  // Trials still running right now (state, not a window): how many are in
  // flight, and how many of those have already turned off auto-renew — a
  // leading indicator of where the conversion rate is heading. Deliberately
  // NOT part of any denominator; these trials haven't resolved yet.
  keys.push("inflight");
  statements.push(
    env.DB.prepare(
      `SELECT t.bundle_id, COUNT(*) AS in_flight,
              SUM(CASE WHEN EXISTS (
                    SELECT 1 FROM notifications c
                    WHERE c.original_transaction_id = t.original_transaction_id
                      AND c.notification_type = 'DID_CHANGE_RENEWAL_STATUS'
                      AND c.subtype = 'AUTO_RENEW_DISABLED'
                      AND c.signed_date > t.signed_date
                  ) THEN 1 ELSE 0 END) AS canceled
       FROM notifications t
       WHERE t.environment = 'Production'
         AND t.offer_discount_type = 'FREE_TRIAL' AND t.subtype = 'INITIAL_BUY'
         AND (t.in_app_ownership_type IS NULL OR t.in_app_ownership_type != 'FAMILY_SHARED')
         AND t.expires_date > ?
         -- "In flight" must mean STILL DECIDING. Apple bills ~8h before a
         -- trial expires, so without this a subscriber who has already been
         -- charged keeps showing up as pending until their trial period
         -- formally ends — and would then contradict the subscriber panel,
         -- which is already (correctly) counting them as paying.
         AND NOT EXISTS (
               SELECT 1 FROM notifications p
               WHERE p.original_transaction_id = t.original_transaction_id
                 AND p.price > 0 AND p.signed_date > t.signed_date
                 AND (p.in_app_ownership_type IS NULL OR p.in_app_ownership_type != 'FAMILY_SHARED')
                 AND (p.offer_discount_type IS NULL OR p.offer_discount_type != 'FREE_TRIAL')
                 AND (p.notification_type IN ('DID_RENEW', 'ONE_TIME_CHARGE')
                      OR (p.notification_type IN ('SUBSCRIBED', 'OFFER_REDEEMED')
                          AND p.subtype IN ('INITIAL_BUY', 'RESUBSCRIBE'))))
       GROUP BY t.bundle_id`
    ).bind(now)
  );

  // Paying subscriber base, by plan. Like the projection and the in-flight
  // count above this is STATE, not a window: "who is subscribed right now".
  // It must not move when the window selector does.
  //
  // One subscriber is one original_transaction_id. Their current standing is
  // the row carrying the furthest-out expires_date — for a converted trial
  // that's the DID_RENEW (paid, later end date), for a live trial it's the
  // INITIAL_BUY. Ties are broken by signed_date so a mid-period
  // AUTO_RENEW_DISABLED wins over the DID_RENEW it shares an end date with,
  // which is what makes `lapsing` visible at all.
  //
  // "Paying" means the CURRENT period is paid — a running free trial is not a
  // paying subscriber, it's the pipeline, and is reported separately as
  // `trialing`. Someone who has turned auto-renew off is still paying (they
  // bought the period they're in) but is counted as `lapsing`, since the run
  // rate below should not bank money that is already walking out.
  //
  // Non-renewing products never appear here: they have no expires_date, so
  // Overflight's lifetime unlock and CD Wally's are excluded by construction
  // rather than by a hardcoded list.
  keys.push("subs");
  statements.push(
    env.DB.prepare(
      `WITH latest AS (
         SELECT n.bundle_id, n.product_id, n.currency, n.price,
                n.expires_date, n.purchase_date, n.offer_discount_type,
                n.offer_type, n.auto_renew_status,
                ROW_NUMBER() OVER (PARTITION BY n.original_transaction_id
                                   ORDER BY n.expires_date DESC, n.signed_date DESC) AS rn
         FROM notifications n
         WHERE n.environment = 'Production'
           AND n.expires_date IS NOT NULL
           AND n.original_transaction_id IS NOT NULL
           AND (n.in_app_ownership_type IS NULL OR n.in_app_ownership_type != 'FAMILY_SHARED')
       ),
       sub AS (
         SELECT bundle_id, product_id, currency, price, offer_type,
                (auto_renew_status IS NULL OR auto_renew_status != 0) AS renewing,
                (expires_date - purchase_date) / 86400000.0 AS period_days,
                (price > 0 AND (offer_discount_type IS NULL
                                OR offer_discount_type != 'FREE_TRIAL')) AS paid
         FROM latest WHERE rn = 1 AND expires_date > ?
       )
       SELECT s.bundle_id, s.product_id,
              SUM(s.paid) AS paying,
              SUM(CASE WHEN s.paid AND s.offer_type = 3 THEN 1 ELSE 0 END) AS offer_code,
              SUM(CASE WHEN s.paid AND NOT s.renewing THEN 1 ELSE 0 END) AS lapsing,
              SUM(CASE WHEN s.paid THEN 0 ELSE 1 END) AS trialing,
              -- MRR: every subscription normalised to a month from its OWN
              -- period length, rather than from the product id, so a weekly or
              -- six-month plan needs no code. 30.44 = 365.25 / 12.
              SUM(CASE WHEN s.paid AND fx.usd_rate IS NOT NULL AND s.period_days > 0
                       THEN s.price * fx.usd_rate * 30.44 / s.period_days ELSE 0 END) AS mrr_millis,
              -- The slice of that MRR whose owner has already switched
              -- auto-renew off: still paying this period, gone by the next.
              SUM(CASE WHEN s.paid AND NOT s.renewing AND fx.usd_rate IS NOT NULL AND s.period_days > 0
                       THEN s.price * fx.usd_rate * 30.44 / s.period_days ELSE 0 END) AS mrr_lapsing_millis,
              SUM(CASE WHEN s.paid AND fx.usd_rate IS NULL THEN 1 ELSE 0 END) AS unknown_fx
       FROM sub s LEFT JOIN fx_rates fx ON fx.currency = s.currency
       GROUP BY s.bundle_id, s.product_id`
    ).bind(now)
  );

  // Lifetime unlocks — the non-renewing way to buy the same entitlement the
  // subscriptions grant. No expires_date, so they are invisible to every query
  // above and need counting on their own terms: an owner, not a subscriber,
  // and no MRR to contribute.
  //
  // A refund is a real un-purchase here in a way it is not for a subscription:
  // the entitlement goes away and the owner count must drop with it. A later
  // REFUND_REVERSED puts them back.
  keys.push("unlocks");
  statements.push(
    env.DB.prepare(
      `SELECT n.bundle_id, n.product_id,
              COUNT(*) AS owners,
              SUM(CASE WHEN n.offer_type = 3 THEN 1 ELSE 0 END) AS offer_code,
              SUM(CASE WHEN fx.usd_rate IS NOT NULL THEN n.price * fx.usd_rate ELSE 0 END) AS gross_millis,
              SUM(CASE WHEN fx.usd_rate IS NULL THEN 1 ELSE 0 END) AS unknown_fx
       FROM notifications n LEFT JOIN fx_rates fx ON fx.currency = n.currency
       WHERE n.environment = 'Production'
         AND n.notification_type = 'ONE_TIME_CHARGE'
         AND n.expires_date IS NULL
         AND (n.in_app_ownership_type IS NULL OR n.in_app_ownership_type != 'FAMILY_SHARED')
         AND NOT EXISTS (
               SELECT 1 FROM notifications r
               WHERE r.transaction_id = n.transaction_id
                 AND r.notification_type = 'REFUND'
                 AND NOT EXISTS (
                       SELECT 1 FROM notifications rr
                       WHERE rr.transaction_id = r.transaction_id
                         AND rr.notification_type = 'REFUND_REVERSED'
                         AND rr.signed_date > r.signed_date))
       GROUP BY n.bundle_id, n.product_id`
    )
  );

  // The sticker price of each plan, for the panel above to show beside the
  // count. Taken from the most recent USD sale at full price — offers and
  // trials are skipped so a promo can't masquerade as the list price.
  // period_days is null for one-time products, which is what marks them as
  // priced once rather than per period.
  keys.push("plan_price");
  statements.push(
    env.DB.prepare(
      `SELECT product_id, price AS list_millis,
              CASE WHEN expires_date IS NOT NULL AND purchase_date IS NOT NULL
                   THEN CAST(ROUND((expires_date - purchase_date) / 86400000.0) AS INTEGER)
                   END AS period_days
       FROM (
         SELECT n.product_id, n.price, n.expires_date, n.purchase_date,
                ROW_NUMBER() OVER (PARTITION BY n.product_id ORDER BY n.signed_date DESC) AS rn
         FROM notifications n
         WHERE n.environment = 'Production' AND n.currency = 'USD' AND n.price > 0
           AND n.offer_type IS NULL
           AND (n.offer_discount_type IS NULL OR n.offer_discount_type != 'FREE_TRIAL')
           AND (n.in_app_ownership_type IS NULL OR n.in_app_ownership_type != 'FAMILY_SHARED')
       )
       WHERE rn = 1`
    )
  );

  // MRR history, one point per day for the last 90.
  //
  // The unit is a PAID PERIOD — one billing cycle a customer was actually
  // charged for, keyed by its own transaction_id. Free trials are excluded
  // (nobody paid), so the curve starts when the first trial converted, not at
  // launch.
  //
  // Coverage is evaluated per SUBSCRIBER, not per period: on each day, take
  // the most recent period that subscriber had paid for by then, and count it
  // if it still had time left. Doing it per period instead would double-count
  // every renewal — Apple bills ~8h before the previous cycle ends, so the old
  // and new periods briefly overlap. This is the same "latest row wins" rule
  // the subscriber panel uses, evaluated at a past instant, which is what
  // makes the final point of this curve equal the headline figure.
  //
  // Periods that had already ended before the window opens are dropped: they
  // contribute nothing to any day in it, and without that filter this query
  // would grow with all history rather than with the active base.
  const TREND_DAYS = 90;
  const trendStart = now - (TREND_DAYS - 1) * 86400000;
  keys.push("mrr_trend");
  statements.push(
    env.DB.prepare(
      `WITH RECURSIVE
       periods AS (
         SELECT n.transaction_id,
                MIN(n.original_transaction_id) AS oid,
                MIN(n.signed_date) AS paid_at,
                MIN(n.expires_date) AS end_at,
                MAX(n.price * fx.usd_rate * 30.44
                    / ((n.expires_date - n.purchase_date) / 86400000.0)) AS monthly_millis
         FROM notifications n JOIN fx_rates fx ON fx.currency = n.currency
         WHERE n.environment = 'Production' AND n.price > 0
           AND n.expires_date IS NOT NULL AND n.purchase_date IS NOT NULL
           AND n.expires_date > n.purchase_date
           AND n.expires_date > ?
           AND (n.in_app_ownership_type IS NULL OR n.in_app_ownership_type != 'FAMILY_SHARED')
           AND (n.offer_discount_type IS NULL OR n.offer_discount_type != 'FREE_TRIAL')
           AND (n.notification_type = 'DID_RENEW'
                OR (n.notification_type IN ('SUBSCRIBED', 'OFFER_REDEEMED')
                    AND n.subtype IN ('INITIAL_BUY', 'RESUBSCRIBE')))
         GROUP BY n.transaction_id
       ),
       days(d) AS (
         SELECT ? UNION ALL SELECT d + 86400000 FROM days WHERE d + 86400000 <= ?
       ),
       cover AS (
         SELECT days.d AS d, p.end_at, p.monthly_millis,
                ROW_NUMBER() OVER (PARTITION BY days.d, p.oid ORDER BY p.paid_at DESC) AS rn
         FROM days JOIN periods p ON p.paid_at <= days.d
       )
       SELECT d,
              SUM(CASE WHEN end_at > d THEN monthly_millis ELSE 0 END) AS mrr_millis,
              SUM(CASE WHEN end_at > d THEN 1 ELSE 0 END) AS subs
       FROM cover WHERE rn = 1 GROUP BY d ORDER BY d`
    ).bind(trendStart, trendStart, now)
  );

  // One row per trial, for the projection below. Small table (hundreds of
  // rows), so the modelling happens in JS where it can be read.
  keys.push("trial_rows");
  statements.push(
    env.DB.prepare(
      `SELECT t.bundle_id, t.signed_date AS start, t.expires_date AS trial_end,
              (SELECT MIN(c.signed_date) FROM notifications c
                WHERE c.original_transaction_id = t.original_transaction_id
                  AND c.notification_type = 'DID_CHANGE_RENEWAL_STATUS'
                  AND c.subtype = 'AUTO_RENEW_DISABLED'
                  AND c.signed_date > t.signed_date) AS cancel_at,
              EXISTS (SELECT 1 FROM notifications p
                WHERE p.original_transaction_id = t.original_transaction_id
                  AND p.price > 0 AND p.signed_date > t.signed_date
                  AND (p.in_app_ownership_type IS NULL OR p.in_app_ownership_type != 'FAMILY_SHARED')
                  AND (p.offer_discount_type IS NULL OR p.offer_discount_type != 'FREE_TRIAL')
                  AND (p.notification_type IN ('DID_RENEW', 'ONE_TIME_CHARGE')
                       OR (p.notification_type IN ('SUBSCRIBED', 'OFFER_REDEEMED')
                           AND p.subtype IN ('INITIAL_BUY', 'RESUBSCRIBE')))) AS converted
       FROM notifications t
       WHERE t.environment = 'Production'
         AND t.offer_discount_type = 'FREE_TRIAL' AND t.subtype = 'INITIAL_BUY'
         AND (t.in_app_ownership_type IS NULL OR t.in_app_ownership_type != 'FAMILY_SHARED')
         AND t.expires_date IS NOT NULL AND t.expires_date > t.signed_date`
    )
  );

  keys.push("feed");
  statements.push(
    env.DB.prepare(
      `SELECT notification_uuid, signed_date, notification_type, subtype, bundle_id,
              environment, product_id, price, currency, storefront, offer_discount_type
       FROM notifications
       ORDER BY signed_date DESC LIMIT 40`
    )
  );

  keys.push("meta");
  statements.push(
    env.DB.prepare(
      `SELECT COUNT(*) AS total, MIN(signed_date) AS oldest, MAX(signed_date) AS newest
       FROM notifications WHERE environment = 'Production'`
    )
  );

  const results = await env.DB.batch(statements);
  const byKey = Object.fromEntries(keys.map((k, i) => [k, results[i].results]));

  const isRevenueRow = (r) =>
    ((["DID_RENEW", "ONE_TIME_CHARGE"].includes(r.notification_type)) ||
      (["SUBSCRIBED", "OFFER_REDEEMED"].includes(r.notification_type) &&
        ["INITIAL_BUY", "RESUBSCRIBE"].includes(r.subtype))) &&
    r.offer_discount_type !== "FREE_TRIAL";

  const windows = {};
  for (const key of Object.keys(WINDOWS)) {
    const agg = byKey[`agg:${key}`] || [];
    const trial = byKey[`trial:${key}`] || [];
    const inflight = byKey.inflight || [];
    const apps = {};
    const app = (id) => {
      const k = id || "unknown";
      if (!apps[k]) {
        apps[k] = {
          name: appName(k),
          revenue_usd: 0, refunds_usd: 0, events: 0,
          new_subs: 0, offer_codes: 0, resubscribes: 0, trial_starts: 0, trial_conversions: 0,
          trials_resolved: 0, trials_in_flight: 0, trials_canceled_in_flight: 0,
          trial_conversion_usd: 0, renewals: 0, one_time: 0, refunds: 0,
          auto_renew_off: 0, expired: 0, renewal_failed: 0, unknown_fx: 0,
        };
      }
      return apps[k];
    };

    for (const r of agg) {
      const a = app(r.bundle_id);
      a.events += r.n;
      // Family Sharing copies are not sales. When one customer buys a shareable
      // product, Apple sends an extra notification per family member with
      // inAppOwnershipType = FAMILY_SHARED and the FULL product price attached,
      // even though nobody paid for that copy. Counting them turned CD Wally's
      // 23 real unlocks into 56 and more than doubled its revenue. They stay in
      // `events` (they really did arrive) but count toward nothing else.
      if (r.in_app_ownership_type === "FAMILY_SHARED") continue;
      a.unknown_fx += r.unknown_fx;
      if (isRevenueRow(r)) a.revenue_usd += (r.usd_millis || 0) / 1000;
      if (r.notification_type === "REFUND") {
        a.refunds += r.n;
        a.refunds_usd += (r.usd_millis || 0) / 1000;
      }
      if (r.notification_type === "REFUND_REVERSED") {
        a.refunds -= r.n;
        a.refunds_usd -= (r.usd_millis || 0) / 1000;
      }
      // How a subscription started. Offer-code redemptions (offerType 3) are
      // kept out of new_subs: they're promo redemptions at a discounted price,
      // not organic paid signups, and lumping them together overstates both the
      // count and the average revenue per subscriber. A code that grants a free
      // trial still counts as a trial start — it behaves like one.
      if (["SUBSCRIBED", "OFFER_REDEEMED"].includes(r.notification_type) && r.subtype === "INITIAL_BUY") {
        if (r.offer_discount_type === "FREE_TRIAL") a.trial_starts += r.n;
        else if (r.offer_type === 3) a.offer_codes += r.n;
        else a.new_subs += r.n;
      }
      if ((r.notification_type === "SUBSCRIBED" || r.notification_type === "OFFER_REDEEMED") && r.subtype === "RESUBSCRIBE") {
        a.resubscribes += r.n;
      }
      if (r.notification_type === "DID_RENEW") a.renewals += r.n;
      if (r.notification_type === "ONE_TIME_CHARGE") a.one_time += r.n;
      if (r.notification_type === "DID_FAIL_TO_RENEW") a.renewal_failed += r.n;
      if (r.notification_type === "EXPIRED") a.expired += r.n;
      if (r.notification_type === "DID_CHANGE_RENEWAL_STATUS" && r.subtype === "AUTO_RENEW_DISABLED") {
        a.auto_renew_off += r.n;
      }
    }

    for (const r of trial) {
      const a = app(r.bundle_id);
      a.trials_resolved += r.resolved;
      a.trial_conversions += r.converted;
      a.trial_conversion_usd += (r.usd_millis || 0) / 1000;
    }

    for (const r of inflight) {
      const a = app(r.bundle_id);
      a.trials_in_flight += r.in_flight;
      a.trials_canceled_in_flight += r.canceled;
    }

    const total = {
      name: "All Products",
      revenue_usd: 0, refunds_usd: 0, events: 0,
      new_subs: 0, offer_codes: 0, resubscribes: 0, trial_starts: 0, trial_conversions: 0,
      trials_resolved: 0, trials_in_flight: 0, trials_canceled_in_flight: 0,
      trial_conversion_usd: 0, renewals: 0, one_time: 0, refunds: 0,
      auto_renew_off: 0, expired: 0, renewal_failed: 0, unknown_fx: 0,
    };
    for (const a of Object.values(apps)) {
      for (const k of Object.keys(total)) {
        if (typeof total[k] === "number") total[k] += a[k];
      }
    }

    windows[key] = { apps, total };
  }

  // Projection describes the pending pool as it stands, so it is deliberately
  // not window-scoped — changing the window selector must not move it.
  const trialRows = byKey.trial_rows || [];
  const projection = { total: projectTrials(trialRows, now), apps: {} };
  for (const id of new Set(trialRows.map((r) => r.bundle_id))) {
    projection.apps[id] = projectTrials(
      trialRows.filter((r) => r.bundle_id === id),
      now
    );
  }

  // Subscriber base, grouped product → plan. Not window-scoped (see the query).
  const priceByPlan = Object.fromEntries(
    (byKey.plan_price || []).map((r) => [r.product_id, r])
  );
  const subscribers = {};
  for (const r of byKey.subs || []) {
    const id = r.bundle_id || "unknown";
    if (!subscribers[id]) {
      subscribers[id] = {
        name: appName(id),
        paying: 0, lapsing: 0, offer_code: 0, trialing: 0,
        mrr_usd: 0, mrr_lapsing_usd: 0, unknown_fx: 0,
        unlock_owners: 0, unlock_gross_usd: 0, plans: [],
      };
    }
    const s = subscribers[id];
    const price = priceByPlan[r.product_id] || {};
    const plan = {
      product_id: r.product_id,
      kind: "subscription",
      count: r.paying || 0,
      paying: r.paying || 0,
      lapsing: r.lapsing || 0,
      offer_code: r.offer_code || 0,
      trialing: r.trialing || 0,
      mrr_usd: (r.mrr_millis || 0) / 1000,
      mrr_lapsing_usd: (r.mrr_lapsing_millis || 0) / 1000,
      unknown_fx: r.unknown_fx || 0,
      list_usd: price.list_millis != null ? price.list_millis / 1000 : null,
      period_days: price.period_days ?? null,
    };
    s.plans.push(plan);
    for (const k of ["paying", "lapsing", "offer_code", "trialing", "mrr_usd", "mrr_lapsing_usd", "unknown_fx"]) {
      s[k] += plan[k];
    }
  }
  // One-time unlocks join the product they belong to, as rows that carry an
  // owner count but no MRR. A product that sells NOTHING but unlocks (CD Wally)
  // gets an entry of its own here — this panel is the customer base, not the
  // subscriber base, so a product with no subscriptions still has one.
  for (const r of byKey.unlocks || []) {
    const id = r.bundle_id || "unknown";
    if (!subscribers[id]) {
      subscribers[id] = {
        name: appName(id),
        paying: 0, lapsing: 0, offer_code: 0, trialing: 0,
        mrr_usd: 0, mrr_lapsing_usd: 0, unknown_fx: 0,
        unlock_owners: 0, unlock_gross_usd: 0, plans: [],
      };
    }
    const s = subscribers[id];
    const price = priceByPlan[r.product_id] || {};
    s.plans.push({
      product_id: r.product_id,
      kind: "unlock",
      count: r.owners || 0,
      owners: r.owners || 0,
      offer_code: r.offer_code || 0,
      gross_usd: (r.gross_millis || 0) / 1000,
      unknown_fx: r.unknown_fx || 0,
      list_usd: price.list_millis != null ? price.list_millis / 1000 : null,
      period_days: null,
    });
    s.unlock_owners += r.owners || 0;
    s.unlock_gross_usd += (r.gross_millis || 0) / 1000;
    s.unknown_fx += r.unknown_fx || 0;
  }

  for (const s of Object.values(subscribers)) {
    // Recurring plans first, then the one-time way to buy the same thing;
    // within each, by headcount, matching what the panel's bars measure —
    // sorting by MRR instead puts the shortest bar on top, which reads as a
    // rendering bug.
    s.plans.sort(
      (a, b) =>
        (a.kind === b.kind ? 0 : a.kind === "subscription" ? -1 : 1) ||
        b.count - a.count
    );
  }

  // MRR headline and its 90-day history. The headline comes from the same
  // per-subscriber query as the panel above rather than from the last point of
  // the trend, so the two can never drift apart by a rounding rule; they are
  // built to agree by construction (see the trend query's comment).
  const mrrCurrent = Object.values(subscribers).reduce((sum, s) => sum + s.mrr_usd, 0);
  const mrrLapsing = Object.values(subscribers).reduce((sum, s) => sum + s.mrr_lapsing_usd, 0);
  const mrr = {
    current_usd: mrrCurrent,
    lapsing_usd: mrrLapsing,
    subscriptions: Object.values(subscribers).reduce((sum, s) => sum + s.paying, 0),
    trend: (byKey.mrr_trend || []).map((r) => ({
      t: r.d,
      usd: (r.mrr_millis || 0) / 1000,
      subs: r.subs || 0,
    })),
  };

  const meta = byKey.meta?.[0] || {};
  return json({
    generated_at: now,
    windows,
    projection,
    subscribers,
    mrr,
    feed: byKey.feed || [],
    meta: {
      total_events: meta.total || 0,
      oldest: meta.oldest || null,
      newest: meta.newest || null,
      apps: APP_NAMES,
    },
  });
}

// ---------------------------------------------------------------------------
// Chat (Claude over the data)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Analyst console
// ---------------------------------------------------------------------------
//
// Two endpoints, pulling in opposite directions on purpose:
//
//   /api/query  is reachable on workers.dev with a bearer token, because the
//               agent asking the questions runs on bigiron and cannot clear
//               Cloudflare Access. Same shape as /api/backfill, same secret.
//   /api/chat   is reachable ONLY on the Access-guarded hostname, because it
//               is the human's end of the conversation.

/**
 * The read-only guard, and the reason /api/query is safe to expose at all.
 *
 * Every rejection here is deliberate. Comments are stripped first, so a
 * leading "-- innocuous\nDROP ..." cannot sail past the prefix test. Interior
 * semicolons are refused because "SELECT 1; DROP TABLE notifications" is two
 * statements. And WITH is keyword-screened, because SQLite happily allows
 * WITH-prefixed DELETE/INSERT/UPDATE and the prefix test alone would wave
 * those straight through.
 *
 * scripts/ccq.mjs carries a copy of this function for its own pre-flight
 * check, so a mistake is caught before the round trip. This one is the
 * enforcing copy — keep them in step.
 */
function isSelectOnly(sql) {
  const stripped = sql.replace(/--[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ").trim();
  if (!/^(select|with)\b/i.test(stripped)) return false;
  // Reject multiple statements; a single trailing semicolon is fine.
  if (stripped.replace(/;\s*$/, "").includes(";")) return false;
  // SQLite allows WITH-prefixed DELETE/UPDATE/INSERT — a bare SELECT can't
  // contain those as statements, but a WITH can, so keyword-screen it.
  if (/^with\b/i.test(stripped) && /\b(delete|insert|update|replace)\b/i.test(stripped)) return false;
  return true;
}

async function runQuery(env, sql) {
  if (!isSelectOnly(sql)) {
    return { error: "Only single SELECT/WITH statements are allowed." };
  }
  try {
    const { results } = await env.DB.prepare(sql).all();
    const truncated = results.length > 200;
    return { rows: results.slice(0, 200), row_count: results.length, truncated };
  } catch (e) {
    return { error: String(e.message || e) };
  }
}

/**
 * POST /api/query — the analyst agent's only route to the database.
 *
 * Bearer-authenticated and served on workers.dev, mirroring /api/backfill:
 * bigiron is a script, not a browser, and cannot complete an Access one-time
 * PIN. The SELECT-only guard above is what makes that acceptable.
 */
async function handleQuery(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Body must be JSON" }, 400);
  }
  const sql = String(body.sql || "").trim();
  if (!sql) return json({ error: "sql required" }, 400);
  const out = await runQuery(env, sql);
  // A refused or broken query is a 200 with an error field: the agent should
  // read the reason and fix its SQL, not treat it as a transport failure.
  return json(out);
}

/**
 * POST /api/chat — proxy one turn to agent-bridge on bigiron.
 *
 * Deliberately thin: the body passes through as {message, session_id} and the
 * upstream body is returned as the same stream object, so tokens reach the
 * browser as they are produced. Anything done here beyond adding the bearer
 * token is latency on every character.
 */
async function handleChat(request, env) {
  if (!env.CHAT_BRIDGE_URL || !env.CHAT_TOKEN) {
    return sseError("analyst console is not configured — CHAT_BRIDGE_URL/CHAT_TOKEN unset");
  }
  // Request body buffered (it's one short message); the RESPONSE body is what
  // must stream, and that is passed through untouched below.
  const body = await request.text();
  let upstream;
  try {
    upstream = await fetch(`${env.CHAT_BRIDGE_URL}/chat/cha-ching`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.CHAT_TOKEN}`,
      },
      body,
    });
  } catch (e) {
    return sseError("BRIDGE UNREACHABLE — " + String(e.message || e));
  }
  if (upstream.status === 409) {
    return sseError("BUSY — bigiron is already answering a question");
  }
  if (!upstream.ok || !upstream.body) {
    return sseError(`BRIDGE ERROR ${upstream.status}`);
  }
  return new Response(upstream.body, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
    },
  });
}

/** An error the console can render inline, in the shape of a real stream. */
function sseError(message) {
  return new Response(
    `data: ${JSON.stringify({ type: "error", error: message })}\n\n` +
      `data: {"type":"end"}\n\n`,
    {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
      },
    }
  );
}


async function handleAppleIngest(request, env, ctx) {
  try {
    const body = await request.json();
    const { signedPayload } = body;

    if (!signedPayload) {
      console.error("Missing signedPayload in request body");
      return new Response("OK", { status: 200 });
    }

    const decoded = decodeNotification(signedPayload);
    const { notification, transaction, renewalInfo } = decoded;

    // Persist everything — including sandbox and types we don't Slack.
    try {
      await persistStatement(env.DB, decoded).run();
    } catch (e) {
      console.error("Failed to persist notification:", e);
    }

    if (notification.data?.environment === "Sandbox") {
      console.log(`Skipping Sandbox notification: ${notification.notificationType}`);
      return new Response("OK", { status: 200 });
    }

    // Auto-renew-off is a bummer and not actionable — drop it from Slack.
    // (Turn-ons, refunds, and renewal failures still come through.)
    const autoRenewOff =
      notification.notificationType === "DID_CHANGE_RENEWAL_STATUS" &&
      (notification.subtype === "AUTO_RENEW_DISABLED" ||
        (!notification.subtype &&
          renewalInfo?.autoRenewStatus != null &&
          renewalInfo.autoRenewStatus !== 1));
    if (autoRenewOff) {
      console.log("Skipping Auto-Renew Turned Off notification");
      return new Response("OK", { status: 200 });
    }

    // Same for expirations — by the time one lands, auto-renew was already
    // off and there's nothing to do about it.
    if (notification.notificationType === "EXPIRED") {
      console.log("Skipping Subscription Expired notification");
      return new Response("OK", { status: 200 });
    }

    const message = buildSlackMessage(notification, transaction, renewalInfo);

    try {
      await postToSlack(env.SLACK_WEBHOOK_URL, message);
    } catch (e) {
      console.error("Failed to post to Slack:", e);
    }
  } catch (e) {
    console.error("Error processing notification:", e);
  }

  // Always return 200 to Apple
  return new Response("OK", { status: 200 });
}

async function handleBackfill(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Bad request" }, 400);
  }
  const payloads = Array.isArray(body.signedPayloads) ? body.signedPayloads : [];
  if (payloads.length === 0 || payloads.length > 200) {
    return json({ error: "signedPayloads must contain 1-200 entries" }, 400);
  }

  const statements = [];
  let failed = 0;
  for (const signedPayload of payloads) {
    try {
      statements.push(persistStatement(env.DB, decodeNotification(signedPayload)));
    } catch (e) {
      console.error("Backfill decode failed:", e);
      failed++;
    }
  }

  let stored = 0;
  if (statements.length > 0) {
    const results = await env.DB.batch(statements);
    stored = results.reduce((sum, r) => sum + (r.meta?.changes || 0), 0);
  }
  return json({ received: payloads.length, stored, duplicates: statements.length - stored, failed });
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

// Human-facing hostname, behind Cloudflare Access (one-time PIN, same Zero
// Trust org as house.dgrlabs.co). Apple ingest and backfill live on
// workers.dev and are unaffected.
const DASHBOARD_HOSTNAME = "cha-ching.dgrlabs.co";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;

    // Apple posts notifications to the root URL (the workers.dev hostname —
    // that's what App Store Connect is configured with).
    if (request.method === "POST" && pathname === "/") {
      return handleAppleIngest(request, env, ctx);
    }

    // Backfill is script-driven (bearer token) and also stays reachable on
    // workers.dev, where Access can't sit in front of it.
    if (pathname === "/api/backfill" && request.method === "POST") {
      if (!isAuthorized(request, env)) {
        return json({ error: "Unauthorized" }, 401);
      }
      return handleBackfill(request, env);
    }

    // The analyst agent's read-only window onto D1, for the same reason
    // backfill lives out here: it runs as a script on bigiron and cannot
    // complete an Access one-time PIN. Bearer-authenticated, and every
    // statement is screened by isSelectOnly() before it reaches the database.
    if (pathname === "/api/query" && request.method === "POST") {
      // Its own secret, not DASHBOARD_SECRET: "may read the database" and "may
      // write rows into it via backfill" are different privileges and should
      // not be the same string. QUERY_TOKEN lives on bigiron in
      // /etc/cha-ching/ccq.json and nowhere else.
      if (!env.QUERY_TOKEN ||
          request.headers.get("Authorization") !== `Bearer ${env.QUERY_TOKEN}`) {
        return json({ error: "Unauthorized" }, 401);
      }
      return handleQuery(request, env);
    }

    // Everything human-facing — the dashboard shell and its data endpoints —
    // is only served on the Access-protected hostname, so the workers.dev
    // hostname can't be used to slip past Access. Fails closed if Access is
    // ever removed.
    if (url.hostname !== DASHBOARD_HOSTNAME) {
      return new Response("Not found", { status: 404 });
    }
    if (env.ACCESS_ENABLED !== "1") {
      return new Response("Service unavailable", { status: 503 });
    }

    // Past the hostname and Access checks above, every request here has
    // already cleared Cloudflare Access — no further auth of our own.
    if (pathname.startsWith("/api/")) {
      if (pathname === "/api/stats" && request.method === "GET") {
        return handleStats(env);
      }
      // Cheap watermark for the dashboard's live poll: a few bytes and one
      // indexed lookup, so the client can check "has anything landed?" often
      // without paying for the full stats batch. Count is included so a
      // backfill of older rows registers too, not just newer ones.
      if (pathname === "/api/pulse" && request.method === "GET") {
        const row = await env.DB.prepare(
          `SELECT COUNT(*) AS count, MAX(signed_date) AS newest
           FROM notifications WHERE environment = 'Production'`
        ).first();
        return json({ count: row?.count || 0, newest: row?.newest || null });
      }
      if (pathname === "/api/chat" && request.method === "POST") {
        return handleChat(request, env);
      }
      return json({ error: "Not found" }, 404);
    }

    // Everything else (the dashboard) is static assets, served only on the
    // Access-guarded hostname checked above.
    if (request.method === "GET" || request.method === "HEAD") {
      return env.ASSETS.fetch(request);
    }

    return new Response("Method Not Allowed", { status: 405 });
  },
};
