// cha-ching: App Store Server Notifications V2 → D1 + Slack, with an FUI
// dashboard and a Claude chat endpoint over the stored data.

import Anthropic from "@anthropic-ai/sdk";

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
  const matured = rows.filter((r) => r.trial_end <= now);
  const inFlight = rows.filter((r) => r.trial_end > now);
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
       GROUP BY t.bundle_id`
    ).bind(now)
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

  const meta = byKey.meta?.[0] || {};
  return json({
    generated_at: now,
    windows,
    projection,
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

const CHAT_SYSTEM = `You are the analytics console for "cha-ching", DGR Labs' App Store revenue telemetry system. You answer questions about App Store Server Notification data stored in a Cloudflare D1 (SQLite) database, speaking to Charlie, the developer of these apps. Keep answers tight and quantitative; this is a heads-up display, not a report. Use plain prose or compact markdown tables.

## Database schema

TABLE notifications (
  notification_uuid TEXT PRIMARY KEY,
  signed_date INTEGER,          -- ms since epoch when Apple signed the notification
  notification_type TEXT,       -- SUBSCRIBED, DID_RENEW, ONE_TIME_CHARGE, OFFER_REDEEMED, REFUND, EXPIRED, DID_CHANGE_RENEWAL_STATUS, DID_FAIL_TO_RENEW, ...
  subtype TEXT,                 -- e.g. INITIAL_BUY, RESUBSCRIBE, AUTO_RENEW_DISABLED, BILLING_RETRY, VOLUNTARY
  bundle_id TEXT,               -- co.dgrlabs.cdwally / co.dgrlabs.countdowns / co.dgrlabs.overflight / co.dgrlabs.heymuso
  environment TEXT,             -- 'Production' or 'Sandbox' (ALWAYS filter to Production unless asked otherwise)
  product_id TEXT,
  transaction_id TEXT,
  original_transaction_id TEXT, -- subscription lineage key: all events for one subscriber share this
  price INTEGER,                -- price paid in MILLIUNITS of local currency (divide by 1000)
  currency TEXT,
  storefront TEXT,              -- alpha-3 country code
  offer_type INTEGER,           -- 1 intro, 2 promo, 3 offer code, 4 win-back
  offer_identifier TEXT,
  offer_discount_type TEXT,     -- 'FREE_TRIAL', 'PAY_AS_YOU_GO', 'PAY_UP_FRONT', or NULL
  in_app_ownership_type TEXT,   -- 'PURCHASED' or 'FAMILY_SHARED'
  purchase_date INTEGER,        -- ms since epoch
  expires_date INTEGER,         -- ms since epoch
  auto_renew_status INTEGER,    -- 0/1 from renewal info when present
  raw TEXT                      -- full decoded notification JSON
)

TABLE fx_rates (currency TEXT PRIMARY KEY, usd_rate REAL)  -- static approximate rates to USD

## Semantics

- Apps: CD Wally (cdwally, one-time unlock), Countdowns (countdowns, one-time unlock + subscription), Overflight (overflight, subscription with free trial; launched 2026-07-20), HeyMuso (heymuso, unreleased).
- Revenue events: DID_RENEW, ONE_TIME_CHARGE, and SUBSCRIBED/OFFER_REDEEMED with subtype INITIAL_BUY or RESUBSCRIBE — excluding rows where offer_discount_type = 'FREE_TRIAL' or price = 0.
- CRITICAL — always exclude in_app_ownership_type = 'FAMILY_SHARED' from any revenue, purchase-count, or conversion query. Apple sends one extra notification per family member when a shareable product is bought, carrying the FULL product price even though that family member paid nothing. They are the same sale, duplicated. Every cluster in this data is exactly 1 PURCHASED + N FAMILY_SHARED sharing one purchase_date. Counting them once inflated CD Wally's unlocks from 23 to 56 and its revenue from $466 to $1,025. Only count them when the question is explicitly about family sharing reach.
- Estimated USD revenue: SUM(price * usd_rate) / 1000.0 joining fx_rates on currency. All revenue figures are ESTIMATES of gross customer price (no Apple commission, static FX). Estimated proceeds ≈ 85% of gross (small business program).
- Subscription starts split three ways on INITIAL_BUY: free trial (offer_discount_type = 'FREE_TRIAL'), offer-code redemption (offer_type = 3, a promo code at a discounted price — NOT an organic paid signup), and organic paid. Overflight has no immediate-buy option, so every organic start is a trial; its only offer code so far is 'beta-thanks-2026' ($9.99 vs $19.99 yearly, launch week only). Keep codes out of "new subscribers" — they overstate both count and revenue per subscriber.
- Trial start: subtype = 'INITIAL_BUY' AND offer_discount_type = 'FREE_TRIAL'. The trial's own expires_date is when it ends. Overflight's trial is 7 days.
- Trial conversion: a later paid revenue event with the same original_transaction_id.
- IMPORTANT — conversion rate must be measured over RESOLVED trials only: those whose expires_date has passed. A trial still inside its period has not had the chance to convert and must never count as a failure; report those separately as pending. Rate = converted / resolved, NOT converted / all starts (that understates it badly while an app is young).
- Do not add cancellations to the denominator. Cancelling mid-trial (DID_CHANGE_RENEWAL_STATUS / AUTO_RENEW_DISABLED) is the *reason* a trial later fails to convert, not a separate outcome — the same person would be counted twice. Cancellation among in-flight trials is a useful leading indicator of where the rate is heading.
- No settle grace is needed: Apple bills in advance, so DID_RENEW arrives ~8 hours BEFORE the trial's expires_date. Billing retry (DID_FAIL_TO_RENEW) is the rare exception where a verdict lands late.
- History only goes back ~180 days before 2026-08 (Apple's notification-history limit); older CD Wally / Countdowns activity is not in the database.
- Use SQLite date functions against ms epochs, e.g. signed_date >= unixepoch('now', '-7 days') * 1000. Current time comes from unixepoch('now').

## Rules

- Query the database rather than guessing. Multiple queries are fine.
- SELECT/WITH statements only; the tool rejects anything else.
- Round money to cents. Say when a figure is an estimate or a sample is small.`;

const QUERY_TOOL = {
  name: "query_db",
  description:
    "Run a read-only SQL query (SELECT or WITH ... SELECT) against the cha-ching D1 SQLite database. Returns rows as JSON, truncated to 200 rows.",
  input_schema: {
    type: "object",
    properties: {
      sql: { type: "string", description: "A single SELECT (or WITH...SELECT) statement." },
    },
    required: ["sql"],
  },
};

function isSelectOnly(sql) {
  const stripped = sql.replace(/--[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ").trim();
  if (!/^(select|with)\b/i.test(stripped)) return false;
  // Reject multiple statements; a single trailing semicolon is fine.
  if (stripped.replace(/;\s*$/, "").includes(";")) return false;
  // SQLite allows WITH-prefixed DELETE/UPDATE/INSERT — a bare SELECT can't
  // contain those statements, but a WITH can, so keyword-screen it.
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

async function handleChat(request, env, ctx) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Bad request" }, 400);
  }
  const history = Array.isArray(body.messages) ? body.messages : [];
  if (history.length === 0 || history.length > 60) {
    return json({ error: "messages must contain 1-60 entries" }, 400);
  }

  const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  const send = (event) => writer.write(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));

  const run = async () => {
    try {
      const messages = history.map((m) => ({
        role: m.role === "assistant" ? "assistant" : "user",
        content: String(m.content ?? ""),
      }));

      for (let turn = 0; turn < 8; turn++) {
        const stream = anthropic.messages.stream({
          model: "claude-opus-5",
          max_tokens: 16000,
          system: CHAT_SYSTEM,
          tools: [QUERY_TOOL],
          messages,
        });

        stream.on("text", (delta) => send({ type: "text", text: delta }));
        const message = await stream.finalMessage();

        if (message.stop_reason === "refusal") {
          await send({ type: "error", error: "Claude declined to answer that." });
          break;
        }

        const toolUses = message.content.filter((b) => b.type === "tool_use");
        if (message.stop_reason !== "tool_use" || toolUses.length === 0) {
          break;
        }

        messages.push({ role: "assistant", content: message.content });
        const toolResults = [];
        for (const tool of toolUses) {
          await send({ type: "tool", sql: tool.input?.sql || "" });
          const result = await runQuery(env, tool.input?.sql || "");
          toolResults.push({
            type: "tool_result",
            tool_use_id: tool.id,
            content: JSON.stringify(result),
            is_error: Boolean(result.error),
          });
        }
        messages.push({ role: "user", content: toolResults });
      }
      await send({ type: "done" });
    } catch (e) {
      console.error("Chat error:", e);
      try {
        await send({ type: "error", error: "Chat failed: " + String(e.message || e) });
      } catch {}
    } finally {
      try {
        await writer.close();
      } catch {}
    }
  };

  ctx.waitUntil(run());
  return new Response(readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
    },
  });
}

// ---------------------------------------------------------------------------
// Ingest endpoints
// ---------------------------------------------------------------------------

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
        return handleChat(request, env, ctx);
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
