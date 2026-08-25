// Import Apple's App Sessions analytics report into cha-ching's D1.
//
// WHY THIS EXISTS
// None of our apps carry telemetry of their own, so the only usage figures we
// have are App Store Connect's. The Analytics Reports API publishes the "App
// Sessions Standard" report daily, with Apple's own distinct-device counts
// per day, per Monday–Sunday week and per calendar month. That is what the
// dashboard's ACTIVE DEVICES panel shows: DAU, WAU and MAU exactly as Apple
// counts them, plus the 30-day daily trend.
//
// WHAT IT IS NOT
// Opt-in data. Apple only counts devices whose users agreed to share
// analytics with developers, and publishes a report only when at least five
// users contributed — an app with a quiet day simply has no row for it. And
// there is no rolling "active in the last 30 days" figure here; that number
// exists only in the App Store Connect web UI. See CLAUDE.md before deriving
// one.
//
// HOW APPLE PUBLISHES IT
// A report request (accessType ONGOING) exists per app — created once, from
// an Admin key. Each day Apple adds an INSTANCE per granularity; a daily
// instance carries the last several days in full, restating them as late
// events arrive ("complete within five days"). The latest instance wins for
// any date it contains. The Worker enforces that rule; this script only has
// to hand every instance over once.
//
// KEY
// Same Finance-role Team key as sales-import.mjs. Finance can LIST and
// DOWNLOAD analytics reports but cannot create a report request — that needs
// an Admin key, once per app. Apps with no ONGOING request are reported and
// skipped.
//
// Usage:
//   node scripts/analytics-import.mjs             # every instance not yet imported
//   node scripts/analytics-import.mjs --force     # re-import everything Apple still lists
//   node scripts/analytics-import.mjs --dry-run   # fetch and summarise, write nothing

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
  CHA_CHING_URL,
  DASHBOARD_SECRET,
} = process.env;

const required = { APPLE_ISSUER_ID, APPLE_SALES_KEY_ID, APPLE_SALES_KEY_PATH, CHA_CHING_URL, DASHBOARD_SECRET };
for (const [name, value] of Object.entries(required)) {
  if (!value) {
    console.error(`Missing required env var ${name}`);
    process.exit(1);
  }
}

const REPORT_NAME = "App Sessions Standard";
const GRANULARITIES = ["DAILY", "WEEKLY", "MONTHLY"];
const ASC = "https://api.appstoreconnect.apple.com/v1";

const privateKey = createPrivateKey(readFileSync(APPLE_SALES_KEY_PATH, "utf8"));

async function makeToken() {
  return new SignJWT({})
    .setProtectedHeader({ alg: "ES256", kid: APPLE_SALES_KEY_ID, typ: "JWT" })
    .setIssuer(APPLE_ISSUER_ID)
    .setIssuedAt()
    .setExpirationTime("15m")
    .setAudience("appstoreconnect-v1")
    .sign(privateKey);
}

let token = null;
let tokenIssued = 0;
async function bearer() {
  if (!token || Date.now() - tokenIssued > 10 * 60 * 1000) {
    token = await makeToken();
    tokenIssued = Date.now();
  }
  return { Authorization: `Bearer ${token}` };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function asc(url) {
  const resp = await fetch(url, { headers: await bearer() });
  if (resp.status === 429) {
    const retryAfter = Number(resp.headers.get("Retry-After") || 10);
    console.log(`  rate limited; waiting ${retryAfter}s...`);
    await sleep(retryAfter * 1000);
    return asc(url);
  }
  if (!resp.ok) {
    throw new Error(`Apple responded ${resp.status} for ${url}: ${(await resp.text()).slice(0, 300)}`);
  }
  return resp.json();
}

// Follows links.next so a report with more instances than one page still
// comes back whole.
async function ascAll(url) {
  const out = [];
  let next = url;
  while (next) {
    const page = await asc(next);
    out.push(...(page.data || []));
    next = page.links?.next || null;
  }
  return out;
}

async function api(path, options) {
  const resp = await fetch(`${CHA_CHING_URL}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${DASHBOARD_SECRET}`,
      "Content-Type": "application/json",
      "user-agent": "analytics-import/1.0 (cha-ching)",
      ...(options?.headers || {}),
    },
  });
  if (!resp.ok) throw new Error(`Worker responded ${resp.status}: ${await resp.text()}`);
  return resp.json();
}

// Apple's blank cells are a single space, not an empty string.
const clean = (v) => {
  const t = (v ?? "").trim();
  return t === "" ? null : t;
};
const int = (v) => {
  const t = clean(v);
  if (t === null) return null;
  const n = Number(t);
  return Number.isFinite(n) ? Math.round(n) : null;
};

/** Download and parse every segment of one instance into rows. */
async function fetchInstanceRows(instanceId) {
  const segments = await ascAll(`${ASC}/analyticsReportInstances/${instanceId}/segments`);
  const rows = [];
  for (const seg of segments) {
    // Segment URLs are good for five minutes; download straight away.
    const resp = await fetch(seg.attributes.url);
    if (!resp.ok) throw new Error(`segment download ${resp.status}`);
    const text = gunzipSync(Buffer.from(await resp.arrayBuffer())).toString("utf8");
    const lines = text.trim().split("\n");
    if (lines.length < 2) continue;
    const header = lines[0].split("\t").map((h) => h.trim());
    const col = (cells, name) => cells[header.indexOf(name)];
    for (const line of lines.slice(1)) {
      const cells = line.split("\t");
      rows.push({
        date: clean(col(cells, "Date")),
        app_apple_id: clean(col(cells, "App Apple Identifier")),
        app_version: clean(col(cells, "App Version")),
        device: clean(col(cells, "Device")),
        platform_version: clean(col(cells, "Platform Version")),
        source_type: clean(col(cells, "Source Type")),
        page_type: clean(col(cells, "Page Type")),
        download_date: clean(col(cells, "App Download Date")),
        territory: clean(col(cells, "Territory")),
        sessions: int(col(cells, "Sessions")),
        session_duration: int(col(cells, "Total Session Duration")),
        unique_devices: int(col(cells, "Unique Devices")),
      });
    }
  }
  return rows;
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const force = args.includes("--force");

  const done = new Set();
  if (!force && !dryRun) {
    const { instances } = await api("/api/analytics-import", { method: "GET" });
    for (const i of instances) done.add(i.instance_id);
  }

  // Every app on the account, so a new app is picked up the day its report
  // request exists — no list to maintain here.
  const apps = await ascAll(`${ASC}/apps?fields[apps]=bundleId,name&limit=200`);

  let imported = 0;
  let totalRows = 0;
  for (const app of apps) {
    const bundleId = app.attributes.bundleId;
    const requests = await ascAll(`${ASC}/apps/${app.id}/analyticsReportRequests`);
    const ongoing = requests.find(
      (r) => r.attributes.accessType === "ONGOING" && !r.attributes.stoppedDueToInactivity
    );
    if (!ongoing) {
      const stopped = requests.some((r) => r.attributes.stoppedDueToInactivity);
      console.log(
        `${bundleId}: no ONGOING analytics request` +
        `${stopped ? " (previous one stopped for inactivity)" : ""} — needs an Admin key to create; skipped`
      );
      continue;
    }

    const reports = await ascAll(
      `${ASC}/analyticsReportRequests/${ongoing.id}/reports?filter[name]=${encodeURIComponent(REPORT_NAME)}`
    );
    const report = reports.find((r) => r.attributes.name === REPORT_NAME);
    if (!report) {
      console.log(`${bundleId}: "${REPORT_NAME}" not offered on its request yet; skipped`);
      continue;
    }

    for (const granularity of GRANULARITIES) {
      const instances = (
        await ascAll(`${ASC}/analyticsReports/${report.id}/instances?filter[granularity]=${granularity}&limit=200`)
      )
        .filter((i) => !done.has(i.id))
        .sort((a, b) => (a.attributes.processingDate < b.attributes.processingDate ? -1 : 1));
      if (!instances.length) continue;

      for (const inst of instances) {
        const processingDate = inst.attributes.processingDate;
        let rows;
        try {
          rows = await fetchInstanceRows(inst.id);
        } catch (e) {
          console.error(`  ${bundleId} ${granularity} ${processingDate}: ${e.message}`);
          continue;
        }
        const dates = [...new Set(rows.map((r) => r.date))].sort();
        console.log(
          `  ${bundleId} ${granularity} pd=${processingDate}: ${rows.length} rows` +
          `${dates.length ? ` (${dates[0]}${dates.length > 1 ? ` … ${dates[dates.length - 1]}` : ""})` : ""}` +
          `${dryRun ? " [dry run]" : ""}`
        );
        totalRows += rows.length;
        if (dryRun) continue;
        await api("/api/analytics-import", {
          method: "POST",
          body: JSON.stringify({ instanceId: inst.id, bundleId, granularity, processingDate, rows }),
        });
        imported++;
      }
    }
  }

  console.log(`\n${imported} instance(s) imported, ${totalRows} rows${done.size ? `; ${done.size} already held` : ""}.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
