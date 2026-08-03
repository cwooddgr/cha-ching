// Backfill historical App Store Server Notifications into cha-ching's D1.
//
// Pulls up to 180 days of notification history per app from Apple's
// "Get Notification History" endpoint and POSTs the signedPayloads to the
// worker's /api/backfill endpoint (which stores them without Slacking).
//
// Requires an App Store Connect In-App Purchase key (.p8). Nothing here is
// deployed — the key stays on this machine.
//
// Usage:
//   APPLE_ISSUER_ID=... APPLE_KEY_ID=... APPLE_KEY_PATH=./AuthKey_XXXX.p8 \
//   CHA_CHING_URL=https://cha-ching.<subdomain>.workers.dev \
//   DASHBOARD_SECRET=... \
//   node scripts/backfill.mjs [bundleId ...]
//
// With no arguments, backfills all four apps.

import { createPrivateKey } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { SignJWT } from "jose";

// Load ./.backfill.env (KEY=VALUE lines, gitignored) so credentials don't
// have to be passed on the command line. Real environment variables win.
if (existsSync(".backfill.env")) {
  for (const line of readFileSync(".backfill.env", "utf8").split("\n")) {
    const match = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (match && !(match[1] in process.env)) process.env[match[1]] = match[2];
  }
}

const BUNDLE_IDS = [
  "co.dgrlabs.cdwally",
  "co.dgrlabs.countdowns",
  "co.dgrlabs.overflight",
  "co.dgrlabs.heymuso",
];

const {
  APPLE_ISSUER_ID,
  APPLE_KEY_ID,
  APPLE_KEY_PATH,
  CHA_CHING_URL,
  DASHBOARD_SECRET,
} = process.env;

for (const [name, value] of Object.entries({ APPLE_ISSUER_ID, APPLE_KEY_ID, APPLE_KEY_PATH, CHA_CHING_URL, DASHBOARD_SECRET })) {
  if (!value) {
    console.error(`Missing required env var ${name}`);
    process.exit(1);
  }
}

const privateKey = createPrivateKey(readFileSync(APPLE_KEY_PATH, "utf8"));

// App Store Server API JWTs: ES256, kid header, iss/iat/exp/aud/bid claims,
// max 60 minutes of validity.
async function makeToken(bundleId) {
  return new SignJWT({ bid: bundleId })
    .setProtectedHeader({ alg: "ES256", kid: APPLE_KEY_ID, typ: "JWT" })
    .setIssuer(APPLE_ISSUER_ID)
    .setIssuedAt()
    .setExpirationTime("55m")
    .setAudience("appstoreconnect-v1")
    .sign(privateKey);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchHistoryPage(token, startDate, endDate, paginationToken) {
  const url = new URL("https://api.storekit.apple.com/inApps/v1/notifications/history");
  if (paginationToken) url.searchParams.set("paginationToken", paginationToken);

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ startDate, endDate }),
  });

  if (resp.status === 429) {
    const retryAfter = Number(resp.headers.get("Retry-After") || 5);
    console.log(`  Rate limited; waiting ${retryAfter}s...`);
    await sleep(retryAfter * 1000);
    return fetchHistoryPage(token, startDate, endDate, paginationToken);
  }
  if (!resp.ok) {
    throw new Error(`Apple responded ${resp.status}: ${await resp.text()}`);
  }
  return resp.json();
}

async function uploadBatch(signedPayloads) {
  const resp = await fetch(`${CHA_CHING_URL}/api/backfill`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${DASHBOARD_SECRET}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ signedPayloads }),
  });
  if (!resp.ok) {
    throw new Error(`Worker responded ${resp.status}: ${await resp.text()}`);
  }
  return resp.json();
}

async function backfillApp(bundleId) {
  console.log(`\n=== ${bundleId} ===`);
  // History is available for the past 180 days; leave a small margin.
  const endDate = Date.now();
  const startDate = endDate - 179 * 24 * 60 * 60 * 1000;

  let token = await makeToken(bundleId);
  const tokenIssued = Date.now();
  let paginationToken;
  let pages = 0;
  let stored = 0;
  let duplicates = 0;
  let buffer = [];

  const flush = async () => {
    if (buffer.length === 0) return;
    const result = await uploadBatch(buffer);
    stored += result.stored;
    duplicates += result.duplicates;
    buffer = [];
  };

  do {
    if (Date.now() - tokenIssued > 45 * 60 * 1000) token = await makeToken(bundleId);
    const page = await fetchHistoryPage(token, startDate, endDate, paginationToken);
    pages++;
    for (const item of page.notificationHistory || []) {
      if (item.signedPayload) buffer.push(item.signedPayload);
    }
    if (buffer.length >= 100) await flush();
    paginationToken = page.hasMore ? page.paginationToken : undefined;
    if (pages % 25 === 0) console.log(`  ...${pages} pages fetched`);
  } while (paginationToken);

  await flush();
  console.log(`  ${pages} pages, ${stored} stored, ${duplicates} already present`);
}

const targets = process.argv.slice(2).length > 0 ? process.argv.slice(2) : BUNDLE_IDS;
for (const bundleId of targets) {
  try {
    await backfillApp(bundleId);
  } catch (e) {
    console.error(`Backfill failed for ${bundleId}:`, e.message);
  }
}
