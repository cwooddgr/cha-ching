// Import Apple's DAILY Summary Sales reports into cha-ching's D1.
//
// WHY THIS EXISTS
// `notifications` only reaches back 180 days (Apple's notification-history
// limit), which truncates CD Wally's lifetime totals and misses Countdowns
// altogether. Sales and Trends daily reports are retained for a year and, as
// it turns out, our first revenue month is 2026-02 — so this reaches the
// actual beginning of the business. They also carry Apple's real developer
// proceeds instead of our static-FX estimate.
//
// WHAT IT IS NOT
// Sales reports are AGGREGATES. There are no transaction ids in them, so they
// cannot tell you who is subscribed, what MRR is, or whether a trial
// converted. Those still come from `notifications`. This table owns units and
// revenue; that one owns state and flow.
//
// KEY
// Needs an App Store Connect API **Team key** with the Finance role — NOT the
// In-App Purchase key used by backfill.mjs, which Apple restricts to the App
// Store Server API. Both keys live in this directory and are gitignored.
//
// Usage:
//   node scripts/sales-import.mjs                 # everything missing, from FIRST_REPORT_DATE
//   node scripts/sales-import.mjs --since 2026-07-01
//   node scripts/sales-import.mjs --force         # re-fetch days already imported
//   node scripts/sales-import.mjs --dry-run       # fetch and summarise, write nothing

import { createPrivateKey } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { SignJWT } from "jose";

if (existsSync(".backfill.env")) {
  for (const line of readFileSync(".backfill.env", "utf8").split("\n")) {
    const match = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (match && !(match[1] in process.env)) process.env[match[1]] = match[2];
  }
}

const {
  APPLE_ISSUER_ID,
  APPLE_SALES_KEY_ID,
  APPLE_SALES_KEY_PATH,
  APPLE_VENDOR_NUMBER,
  CHA_CHING_URL,
  DASHBOARD_SECRET,
} = process.env;

const required = {
  APPLE_ISSUER_ID, APPLE_SALES_KEY_ID, APPLE_SALES_KEY_PATH,
  APPLE_VENDOR_NUMBER, CHA_CHING_URL, DASHBOARD_SECRET,
};
for (const [name, value] of Object.entries(required)) {
  if (!value) {
    console.error(`Missing required env var ${name}`);
    process.exit(1);
  }
}

// Apple returned NOT_FOUND for every 2026-01 and earlier report: there were no
// sales before this. Starting here rather than a year back keeps the first run
// to ~190 requests instead of ~365 of which half are known-empty.
const FIRST_REPORT_DATE = "2026-02-01";

// SKUs are free text chosen at product-creation time and don't reliably
// resemble bundle ids, so the mapping is explicit. Longest prefix wins, which
// is what keeps `co.dgrlabs.cdwally.wallet48` from matching before
// `co.dgrlabs.cdwally` would — both map to the same app anyway, but the IAP
// SKUs of a future app might not.
// Verified against each project's own bundle identifier, 2026-08-10.
const SKU_TO_BUNDLE = [
  ["co.dgrlabs.cdwally", "co.dgrlabs.cdwally"],
  ["co.dgrlabs.overflight", "co.dgrlabs.overflight"],
  ["com.tminus.dgrlabs.app", "co.dgrlabs.countdowns"],
  ["DGR001", "co.dgrlabs.countdowns"],
  ["flipflap-tvos-001", "co.dgrlabs.flipflap"],
  ["bezelbub-macos", "co.dgrlabs.bezelbub"],
].sort((a, b) => b[0].length - a[0].length);

function bundleForSku(sku) {
  const hit = SKU_TO_BUNDLE.find(([prefix]) => sku === prefix || sku.startsWith(`${prefix}.`));
  return hit ? hit[1] : null;
}

const privateKey = createPrivateKey(readFileSync(APPLE_SALES_KEY_PATH, "utf8"));

// App Store Connect API JWTs: ES256, no `bid` claim (that one is the App Store
// Server API's), max 20 minutes of validity.
async function makeToken() {
  return new SignJWT({})
    .setProtectedHeader({ alg: "ES256", kid: APPLE_SALES_KEY_ID, typ: "JWT" })
    .setIssuer(APPLE_ISSUER_ID)
    .setIssuedAt()
    .setExpirationTime("15m")
    .setAudience("appstoreconnect-v1")
    .sign(privateKey);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Apple's blank cells are a single space, not an empty string.
const clean = (v) => {
  const t = (v ?? "").trim();
  return t === "" ? null : t;
};
const num = (v) => {
  const t = clean(v);
  if (t === null) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};

/**
 * Fetch one day. Returns an array of rows, or null when Apple says there were
 * no sales that day — which is an answer, not a failure.
 */
async function fetchDay(token, reportDate) {
  const url = new URL("https://api.appstoreconnect.apple.com/v1/salesReports");
  url.searchParams.set("filter[frequency]", "DAILY");
  url.searchParams.set("filter[reportType]", "SALES");
  url.searchParams.set("filter[reportSubType]", "SUMMARY");
  url.searchParams.set("filter[reportDate]", reportDate);
  url.searchParams.set("filter[vendorNumber]", APPLE_VENDOR_NUMBER);

  const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });

  if (resp.status === 404) return [];
  if (resp.status === 429) {
    const retryAfter = Number(resp.headers.get("Retry-After") || 10);
    console.log(`  rate limited; waiting ${retryAfter}s...`);
    await sleep(retryAfter * 1000);
    return fetchDay(token, reportDate);
  }
  if (resp.status === 410) {
    throw new Error("GONE — outside Apple's one-year retention for daily reports");
  }
  if (!resp.ok) {
    throw new Error(`Apple responded ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
  }

  const text = gunzipSync(Buffer.from(await resp.arrayBuffer())).toString("utf8");
  const lines = text.trim().split("\n");
  const header = lines[0].split("\t").map((h) => h.trim());
  const col = (cells, name) => cells[header.indexOf(name)];

  return lines.slice(1).map((line) => {
    const cells = line.split("\t");
    const sku = clean(col(cells, "SKU")) || "";
    return {
      bundle_id: bundleForSku(sku),
      sku,
      title: clean(col(cells, "Title")),
      product_type: clean(col(cells, "Product Type Identifier")),
      units: num(col(cells, "Units")),
      proceeds_per_unit: num(col(cells, "Developer Proceeds")),
      proceeds_currency: clean(col(cells, "Currency of Proceeds")),
      customer_price: num(col(cells, "Customer Price")),
      customer_currency: clean(col(cells, "Customer Currency")),
      country_code: clean(col(cells, "Country Code")),
      apple_identifier: clean(col(cells, "Apple Identifier")),
      parent_identifier: clean(col(cells, "Parent Identifier")),
      promo_code: clean(col(cells, "Promo Code")),
      order_type: clean(col(cells, "Order Type")),
      subscription: clean(col(cells, "Subscription")),
      period: clean(col(cells, "Period")),
      device: clean(col(cells, "Device")),
      version: clean(col(cells, "Version")),
      begin_date: clean(col(cells, "Begin Date")),
      end_date: clean(col(cells, "End Date")),
    };
  });
}

async function api(path, options) {
  const resp = await fetch(`${CHA_CHING_URL}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${DASHBOARD_SECRET}`,
      "Content-Type": "application/json",
      "user-agent": "sales-import/1.0 (cha-ching)",
      ...(options?.headers || {}),
    },
  });
  if (!resp.ok) throw new Error(`Worker responded ${resp.status}: ${await resp.text()}`);
  return resp.json();
}

function dayRange(from, to) {
  const days = [];
  for (let d = new Date(`${from}T00:00:00Z`); d <= new Date(`${to}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1)) {
    days.push(d.toISOString().slice(0, 10));
  }
  return days;
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const force = args.includes("--force");
  const sinceIdx = args.indexOf("--since");
  const since = sinceIdx >= 0 ? args[sinceIdx + 1] : FIRST_REPORT_DATE;

  // Apple publishes a day's report the following day, so yesterday is the
  // newest that can exist. Pacific Time, but a day of slack costs nothing:
  // the last day simply gets picked up on the next run.
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const done = new Set();
  if (!force && !dryRun) {
    const { days } = await api("/api/sales-import", { method: "GET" });
    for (const d of days) done.add(d.report_date);
  }

  const targets = dayRange(since, yesterday).filter((d) => !done.has(d));
  console.log(
    `${targets.length} day(s) to fetch (${since} → ${yesterday})` +
    `${done.size ? `, ${done.size} already imported` : ""}${dryRun ? " [dry run]" : ""}`
  );

  let token = await makeToken();
  let tokenIssued = Date.now();
  let totalRows = 0;
  let daysWithSales = 0;
  const skus = new Map();

  for (const day of targets) {
    if (Date.now() - tokenIssued > 10 * 60 * 1000) {
      token = await makeToken();
      tokenIssued = Date.now();
    }

    let rows;
    try {
      rows = await fetchDay(token, day);
    } catch (e) {
      console.error(`  ${day}: ${e.message}`);
      continue;
    }

    for (const r of rows) skus.set(r.sku, (skus.get(r.sku) || 0) + 1);
    if (rows.length) daysWithSales++;
    totalRows += rows.length;

    if (!dryRun) {
      await api("/api/sales-import", {
        method: "POST",
        body: JSON.stringify({ reportDate: day, rows }),
      });
    }
    if (rows.length) console.log(`  ${day}: ${rows.length} rows`);
  }

  console.log(`\n${totalRows} rows across ${daysWithSales} day(s) with sales.`);

  const unmapped = [...skus.keys()].filter((s) => !bundleForSku(s));
  if (unmapped.length) {
    console.log(`\n⚠️  SKUs with no bundle_id mapping (add them to SKU_TO_BUNDLE):`);
    for (const s of unmapped) console.log(`   ${s}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
