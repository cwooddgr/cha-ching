#!/usr/bin/env node
// ccq — cha-ching query. The analyst agent's read-only window onto D1.
//
// WHY THIS EXISTS
// The Analyst Console used to run inside the Worker, where Claude got a
// `query_db` tool wired straight to the D1 binding. That console now runs as
// Claude Code on bigiron so it bills Charlie's subscription rather than the
// Anthropic API (decided-by-user 2026-08-09) — and an agent on a box has no D1
// binding, only a shell. This is the tool that replaces it.
//
// WHY IT TALKS TO OUR WORKER, NOT TO CLOUDFLARE'S D1 API
// Going direct would need a Cloudflare API token on bigiron, and Cloudflare has
// no read-only D1 scope — the token would carry D1:Edit, i.e. a write handle to
// production revenue data sitting in a file. Instead this posts to the Worker's
// own /api/query, which is bearer-authenticated with the DASHBOARD_SECRET that
// already exists for /api/backfill, and which screens every statement with
// isSelectOnly() before it reaches the database. No new credential, and the
// guard stays in one place.
//
// The pre-flight check below is a courtesy copy of that guard: it catches a
// bad statement before the round trip and gives the agent the same wording.
// The Worker's copy is the one that enforces. Keep them in step.
//
// agent-bridge grants the cha-ching profile exactly one Bash rule,
// `Bash(ccq *)`, so this script is the entire surface that agent has.
//
// CONFIG /etc/cha-ching/ccq.json (root:cwood 640, NOT in this repo):
//   {"url": "https://cha-ching.<subdomain>.workers.dev/api/query",
//    "token": "<the DASHBOARD_SECRET worker secret>"}
// The workers.dev hostname, not cha-ching.dgrlabs.co: that one is behind
// Cloudflare Access, which a script cannot clear.
//
// Usage:  ccq "SELECT count(*) FROM notifications"
//         ccq --schema
//         echo "SELECT ..." | ccq

import { readFileSync } from "node:fs";

const CONFIG_PATH = process.env.CCQ_CONFIG || "/etc/cha-ching/ccq.json";

function die(msg, code = 1) {
  console.error(`ccq: ${msg}`);
  process.exit(code);
}

function loadConfig() {
  let cfg;
  try {
    cfg = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  } catch (e) {
    die(`cannot read ${CONFIG_PATH}: ${e.message}`);
  }
  for (const k of ["url", "token"]) if (!cfg[k]) die(`config is missing ${k}`);
  return cfg;
}

/** Courtesy copy of the Worker's guard — see the header. */
export function isSelectOnly(sql) {
  const stripped = sql
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .trim();
  if (!/^(select|with)\b/i.test(stripped)) return false;
  if (stripped.replace(/;\s*$/, "").includes(";")) return false;
  if (/^with\b/i.test(stripped) && /\b(delete|insert|update|replace)\b/i.test(stripped)) {
    return false;
  }
  return true;
}

const SCHEMA_SQL =
  "SELECT sql FROM sqlite_master WHERE type IN ('table','index') " +
  "AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'";

async function main() {
  const args = process.argv.slice(2);
  let sql;
  if (args[0] === "--schema") sql = SCHEMA_SQL;
  else if (args.length && args[0] !== "-") sql = args.join(" ");
  else sql = readFileSync(0, "utf8");

  sql = (sql || "").trim();
  if (!sql) die("no SQL given");
  if (!isSelectOnly(sql)) {
    die("refused: only a single SELECT or WITH...SELECT statement is allowed");
  }

  const cfg = loadConfig();
  let resp;
  try {
    resp = await fetch(cfg.url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${cfg.token}`,
        "content-type": "application/json",
        // Cloudflare's edge 403s some default client user-agents on
        // workers.dev (netbot hit this with Python-urllib and it cost an
        // afternoon). Node's default is not currently blocked, but naming
        // ourselves is free and makes the request identifiable in logs.
        "user-agent": "ccq/1.0 (cha-ching analyst)",
      },
      body: JSON.stringify({ sql }),
    });
  } catch (e) {
    die(`cannot reach the worker: ${e.message}`, 2);
  }
  if (!resp.ok) die(`worker returned HTTP ${resp.status}`, 2);

  const out = await resp.json().catch(() => null);
  if (!out) die("worker returned no JSON", 2);
  // A refused or broken query comes back 200 with an error field: the agent
  // should read the reason and fix its SQL, not retry blindly.
  if (out.error) die(out.error, 4);

  process.stdout.write(JSON.stringify(out, null, 2) + "\n");
  if (out.truncated) {
    console.error(
      `ccq: ${out.row_count} rows, showing the first 200 — aggregate in SQL rather than paging`
    );
  }
}

main().catch((e) => die(e.message, 3));
