// cha-ching: App Store Server Notifications V2 → Slack

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
  DID_CHANGE_RENEWAL_STATUS: { _: "Renewal Status Changed" },
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

function buildSlackMessage(notification, transaction) {
  const { notificationType, subtype, data } = notification;
  const isSandbox = data?.environment === "Sandbox";
  const key = eventKey(notificationType, subtype);
  const isRevenue = REVENUE_EVENTS.has(key);
  const isRefund = REFUND_EVENTS.has(notificationType);
  const name = appName(transaction?.bundleId);
  const description = describeEvent(notificationType, subtype);

  let emoji, color;
  if (isRevenue) {
    emoji = "\u{1F4B0}"; // 💰
    color = "#2eb67d";
  } else if (isRefund) {
    emoji = "\u26A0\uFE0F"; // ⚠️
    color = "#e01e5a";
  } else {
    emoji = "\u2139\uFE0F"; // ℹ️
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

  if (!isRevenue && !isRefund && subtype) {
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

export default {
  async fetch(request, env) {
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    try {
      const body = await request.json();
      const { signedPayload } = body;

      if (!signedPayload) {
        console.error("Missing signedPayload in request body");
        return new Response("OK", { status: 200 });
      }

      const notification = decodeJWSPayload(signedPayload);

      if (notification.data?.environment === "Sandbox") {
        console.log(`Skipping Sandbox notification: ${notification.notificationType}`);
        return new Response("OK", { status: 200 });
      }

      let transaction = null;

      if (notification.data?.signedTransactionInfo) {
        try {
          transaction = decodeJWSPayload(notification.data.signedTransactionInfo);
        } catch (e) {
          console.error("Failed to decode signedTransactionInfo:", e);
        }
      }

      const message = buildSlackMessage(notification, transaction);

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
  },
};
