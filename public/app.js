// REV-9000 console — stats rendering, event feed, analyst chat.

(() => {
  "use strict";

  const $ = (sel) => document.querySelector(sel);

  // Below this many resolved trials, the conversion rate is one or two people
  // wide — shown, but visually marked as not-a-trend.
  const LOW_CONFIDENCE_TRIALS = 10;

  const PULSE_MS = 10000;         // watermark check — cheap, so run it often
  const FULL_REFRESH_MS = 120000; // catches time-drift even when nothing lands

  // Event IDs on screen as of the last paint; null until the first one, so the
  // initial render doesn't treat every row as newly arrived.
  let seenEvents = null;

  const APP_CODES = {
    "co.dgrlabs.cdwally": "CDW",
    "co.dgrlabs.countdowns": "CTD",
    "co.dgrlabs.overflight": "OVF",
    "co.dgrlabs.heymuso": "HMU",
  };
  const APP_NAMES = {
    "co.dgrlabs.cdwally": "CD Wally",
    "co.dgrlabs.countdowns": "Countdowns",
    "co.dgrlabs.overflight": "Overflight",
    "co.dgrlabs.heymuso": "HeyMuso",
  };

  const REVENUE_TYPES = new Set(["DID_RENEW", "ONE_TIME_CHARGE", "SUBSCRIBED", "OFFER_REDEEMED"]);

  let stats = null;
  let currentWindow = "7d";
  let refreshTimer = null;

  // The selected window survives a reload. Without this, a refresh silently
  // snapped back to 7D while the numbers on screen had been 30D — which reads
  // as the data changing rather than the window changing.
  const WINDOW_STORE_KEY = "cc_window";

  function storedWindow() {
    try {
      return localStorage.getItem(WINDOW_STORE_KEY);
    } catch {
      return null; // storage disabled — fall back to the default
    }
  }

  function storeWindow(key) {
    try {
      localStorage.setItem(WINDOW_STORE_KEY, key);
    } catch {
      /* not worth surfacing; the session still works, it just won't persist */
    }
  }

  // ── formatting ────────────────────────────────────────────────────────

  const usd = (n) =>
    "$" + (n || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const num = (n) => (n || 0).toLocaleString("en-US");

  // Every timestamp on this console reads in the viewer's own timezone. The
  // rows underneath are UTC and Apple's sales reports are cut on Pacific time,
  // but whoever is watching this is standing in one place and wants to know
  // when a sale landed for THEM. The zone is named once, in the header clock,
  // so the readouts stay short without becoming ambiguous.
  const TZ_LABEL =
    new Intl.DateTimeFormat("en-US", { timeZoneName: "short" })
      .formatToParts(new Date())
      .find((p) => p.type === "timeZoneName")?.value || "LOCAL";

  const pad = (x) => String(x).padStart(2, "0");

  function localStamp(ms) {
    const d = new Date(ms);
    return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function localDate(ms) {
    const d = new Date(ms);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  // ── clock ─────────────────────────────────────────────────────────────

  $("#clock-label").textContent = TZ_LABEL;
  setInterval(() => {
    const d = new Date();
    $("#clock").textContent = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }, 1000);

  // ── console reveal ────────────────────────────────────────────────────
  // There's no login step — Cloudflare Access gates the hostname, so we open
  // straight into the boot reel. Hand the reveal to the fx layer, with a
  // fallback so the console still appears if fx.js failed to load.

  function revealConsole() {
    $("#console").classList.remove("hidden");
    if (window.CCFX) window.CCFX.boot();
    setTimeout(() => document.body.classList.add("booted"), 3000);
  }

  let pulseTimer = null;
  function startPulse() {
    if (pulseTimer) return;
    pulseTimer = setInterval(pulse, PULSE_MS);
  }

  // ── stats ─────────────────────────────────────────────────────────────

  async function loadStats() {
    try {
      const resp = await fetch("/api/stats");
      if (!resp.ok) throw new Error(`stats ${resp.status}`);
      stats = await resp.json();
      $("#link-dot").className = "dot dot-live";
      $("#link-state").textContent = "ONLINE";
      render();
    } catch (e) {
      $("#link-dot").className = "dot dot-down";
      $("#link-state").textContent = "NO LINK";
      console.error(e);
    }
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(loadStats, FULL_REFRESH_MS);
  }

  // Live updates without pushing: poll a tiny watermark endpoint often, and
  // only pay for the full stats batch when something has actually landed. The
  // slow full refresh above still runs regardless, because plenty of numbers
  // drift with time alone — windows slide, trials mature, the projection moves.
  let watermark = null;
  async function pulse() {
    try {
      const resp = await fetch("/api/pulse");
      if (!resp.ok) return;
      const p = await resp.json();
      const seen = `${p.count}:${p.newest}`;
      if (watermark != null && seen !== watermark) loadStats();
      watermark = seen;
    } catch {
      /* transient — the next full refresh will surface a real outage */
    }
  }

  function selectWindow(key, persist) {
    const btn = document.querySelector(`.window-select button[data-window="${key}"]`);
    if (!btn) return; // stale stored value from an older set of windows
    document.querySelectorAll(".window-select button").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    currentWindow = key;
    if (persist) storeWindow(key);
  }

  document.querySelectorAll(".window-select button").forEach((btn) => {
    btn.addEventListener("click", () => {
      selectWindow(btn.dataset.window, true);
      render();
    });
  });

  // Restore before the first paint, so the initial render is already in the
  // right window rather than flashing 7D and jumping.
  const saved = storedWindow();
  if (saved) selectWindow(saved, false);

  // The hero figure counts up to its new value instead of snapping — both on
  // window changes and when fresh revenue lands.
  let heroShown = null;
  let heroRaf = null;
  function animateHero(target) {
    const node = $("#hero-revenue");
    const from = heroShown;
    heroShown = target;
    if (from == null || from === target || matchMedia("(prefers-reduced-motion: reduce)").matches) {
      node.textContent = usd(target);
      return;
    }
    cancelAnimationFrame(heroRaf);
    const t0 = performance.now();
    const DUR = 800;
    const step = (now) => {
      const k = Math.min(1, (now - t0) / DUR);
      const ease = 1 - Math.pow(1 - k, 3);
      node.textContent = usd(from + (target - from) * ease);
      if (k < 1) heroRaf = requestAnimationFrame(step);
    };
    heroRaf = requestAnimationFrame(step);
  }

  function render() {
    if (!stats) return;
    const win = stats.windows[currentWindow];
    if (!win) return;
    const t = win.total;

    // hero
    animateHero(t.revenue_usd);
    // Apple's measured effective rate per app, not a flat 85% — commission is
    // only part of what comes off, and foreign tax makes the real figure lower
    // and app-specific. The rate is shown so the number explains itself.
    $("#hero-proceeds").textContent = usd(t.proceeds_usd);
    // The rate for THIS window's actual mix, derived from the two figures on
    // screen — not meta.proceeds_rate, which is blended across all time. In a
    // window carried by one app the two disagree, and an annotation that
    // doesn't divide into the number beside it is worse than none.
    const rate =
      t.revenue_usd > 0 ? t.proceeds_usd / t.revenue_usd : stats.meta?.proceeds_rate;
    $("#hero-proceeds-rate").textContent = rate ? ` (${(rate * 100).toFixed(1)}% eff.)` : "";
    $("#hero-refunds").textContent = "−" + usd(t.refunds_usd);

    // Trial conversion gauge: converted vs RESOLVED trials — trials whose own
    // period ended inside the window. Trials still running are excluded from
    // both halves (they haven't had their chance yet) and reported separately.
    const resolved = t.trials_resolved;
    const convRate = resolved > 0 ? Math.min(1, t.trial_conversions / resolved) : null;
    const arc = $("#gauge-arc");
    const circumference = 2 * Math.PI * 70;
    arc.setAttribute("stroke-dasharray", circumference);
    arc.style.strokeDashoffset = convRate == null ? circumference : circumference * (1 - convRate);
    $("#gauge-pct").textContent = convRate == null ? "—" : Math.round(convRate * 100) + "%";

    // A handful of trials can swing the rate by tens of points, so say so
    // rather than letting a 1-of-2 window read like a trend.
    const thin = resolved > 0 && resolved < LOW_CONFIDENCE_TRIALS;
    $("#gauge").classList.toggle("thin", thin);
    $("#gauge-basis").textContent =
      resolved > 0 ? `${num(t.trial_conversions)} of ${num(resolved)} resolved` : "no trials resolved yet";
    $("#gauge-pending").textContent = t.trials_in_flight
      ? `${num(t.trials_in_flight)} still in trial · ${num(t.trials_canceled_in_flight)} already canceled`
      : "";

    // Where the rate lands once everything currently running has resolved.
    // Not window-scoped — it describes the pending pool, so it stays put as
    // the window selector changes.
    const proj = stats.projection?.total;
    $("#gauge-projected").innerHTML = proj
      ? `PROJECTED <b>${Math.round(proj.rate * 100)}%</b>`
      : "";

    // tiles
    const tiles = [
      { label: "NEW SUBS · PAID", value: num(t.new_subs) },
      { label: "OFFER CODES", value: num(t.offer_codes) },
      { label: "TRIAL STARTS", value: num(t.trial_starts) },
      { label: "TRIALS RESOLVED", value: num(t.trials_resolved) },
      { label: "TRIAL CONVERSIONS", value: num(t.trial_conversions), sub: usd(t.trial_conversion_usd) },
      { label: "RENEWALS", value: num(t.renewals) },
      { label: "RESUBSCRIBES", value: num(t.resubscribes) },
      { label: "ONE-TIME BUYS", value: num(t.one_time) },
      { label: "AUTO-RENEW OFF", value: num(t.auto_renew_off), cls: t.auto_renew_off > 0 ? "warn" : "" },
      { label: "EXPIRED", value: num(t.expired), cls: t.expired > 0 ? "warn" : "" },
      { label: "RENEWAL FAILED", value: num(t.renewal_failed), cls: t.renewal_failed > 0 ? "warn" : "" },
      { label: "REFUNDS", value: num(t.refunds), cls: t.refunds > 0 ? "bad" : "" },
    ];
    $("#tiles").innerHTML = tiles
      .map(
        (tile) => `
        <div class="tile ${tile.cls || ""}">
          <div class="tile-value">${tile.value}</div>
          <div class="tile-label">${tile.label}</div>
          ${tile.sub ? `<div class="tile-sub">${tile.sub}</div>` : ""}
        </div>`
      )
      .join("");

    // per-app breakdown
    const appEntries = Object.entries(win.apps).sort((a, b) => b[1].revenue_usd - a[1].revenue_usd);
    const maxRev = Math.max(1e-9, ...appEntries.map(([, a]) => a.revenue_usd));
    $("#apps").innerHTML = appEntries.length
      ? appEntries
          .map(([id, a]) => {
            const pct = Math.max(1.5, (a.revenue_usd / maxRev) * 100);
            return `
            <div class="app-row">
              <div class="app-id">
                <div class="app-name">${a.name}</div>
                <div class="app-code">${APP_CODES[id] || "—"} · ${id.split(".").pop().toUpperCase()}</div>
              </div>
              <div class="app-data">
                <div class="app-bar-row">
                  <div class="app-bar-track">
                    <div class="app-bar" style="width:${pct}%"></div>
                  </div>
                  <div class="app-bar-amount">${usd(a.revenue_usd)}</div>
                </div>
                <div class="app-stats">
                  <span>subs <b>${num(a.new_subs)}</b></span>
                  ${a.offer_codes ? `<span>codes <b>${num(a.offer_codes)}</b></span>` : ""}
                  <span>trials <b>${num(a.trial_conversions)}</b>/<b>${num(a.trials_resolved)}</b>${
                    a.trials_in_flight ? ` <span class="pending">+${num(a.trials_in_flight)} pending</span>` : ""
                  }</span>
                  <span>renew <b>${num(a.renewals)}</b></span>
                  <span>1x <b>${num(a.one_time)}</b></span>
                  ${a.refunds ? `<span class="bad">refunds ${num(a.refunds)}</span>` : ""}
                  ${a.unknown_fx ? `<span class="warn">fx? ${num(a.unknown_fx)}</span>` : ""}
                </div>
              </div>
            </div>`;
          })
          .join("")
      : `<div class="chat-hello">NO EVENTS IN WINDOW</div>`;

    renderMrr();
    renderSubscribers();

    // feed
    const feed = stats.feed || [];
    const freshRevenue = []; // fresh production money — the fx layer celebrates these
    const freshRefunds = []; // fresh production refunds — the fx layer sounds the alarm
    $("#feed").innerHTML = feed
      .map((ev) => {
        let cls = "info";
        if (ev.notification_type === "REFUND") cls = "bad";
        else if (["DID_FAIL_TO_RENEW", "GRACE_PERIOD_EXPIRED", "EXPIRED"].includes(ev.notification_type)) cls = "warn";
        else if (REVENUE_TYPES.has(ev.notification_type)) cls = "rev";
        const glyph = { rev: "▲", bad: "▼", warn: "◆", info: "·" }[cls];
        const desc = describe(ev);
        const isTrial = ev.offer_discount_type === "FREE_TRIAL";
        const amt =
          ev.price != null && ev.price > 0 && !isTrial
            ? (ev.price / 1000).toFixed(2) + " " + (ev.currency || "")
            : isTrial
              ? "TRIAL"
              : "";
        const sandbox = ev.environment === "Sandbox";
        // Flash rows that weren't on screen a moment ago — but never on the
        // first paint, or the whole feed lights up on load.
        const fresh = seenEvents !== null && !seenEvents.has(ev.notification_uuid);
        if (fresh && !sandbox && !isTrial && REVENUE_TYPES.has(ev.notification_type) && ev.price > 0) {
          freshRevenue.push({ price: ev.price / 1000, currency: ev.currency || "" });
        }
        if (fresh && !sandbox && ev.notification_type === "REFUND") {
          freshRefunds.push({ price: (ev.price || 0) / 1000, currency: ev.currency || "" });
        }
        return `
        <div class="feed-row${fresh ? " fresh" : ""}">
          <span class="feed-time">${localStamp(ev.signed_date)}</span>
          <span class="feed-app">${APP_CODES[ev.bundle_id] || "—"}</span>
          <span class="feed-desc ${cls}"><span class="glyph">${glyph}</span>${desc}${sandbox ? " [SBX]" : ""}</span>
          <span class="feed-amt ${sandbox ? "sandbox" : ""}">${amt}</span>
        </div>`;
      })
      .join("");
    seenEvents = new Set(feed.map((ev) => ev.notification_uuid));
    $("#feed-note").textContent = `LAST ${feed.length}`;

    if (freshRevenue.length) {
      const label =
        freshRevenue.length === 1
          ? `+ ${freshRevenue[0].price.toFixed(2)} ${freshRevenue[0].currency}`.trim()
          : `${freshRevenue.length} REVENUE EVENTS`;
      document.dispatchEvent(new CustomEvent("cc:chaching", { detail: { label } }));
    }
    if (freshRefunds.length) {
      const label =
        freshRefunds.length === 1 && freshRefunds[0].price > 0
          ? `− ${freshRefunds[0].price.toFixed(2)} ${freshRefunds[0].currency}`.trim()
          : `${freshRefunds.length} REFUND EVENT${freshRefunds.length > 1 ? "S" : ""}`;
      // If a cha-ching fired in the same refresh, hold the alarm until the
      // celebration stamp has cleared — the two moments shouldn't overlap.
      setTimeout(
        () => document.dispatchEvent(new CustomEvent("cc:alert", { detail: { label } })),
        freshRevenue.length ? 2600 : 0,
      );
    }

    // meta
    const m = stats.meta;
    $("#meta-events").textContent = `${num(m.total_events)} EVT`;
    // The horizon reflects what's actually on screen: sliding windows span
    // (now - span) → now, matching the server's cutoff; only ALL spans the
    // dataset itself. For 24H a bare date is useless, so include the time.
    const SPANS = { "24h": 86400000, "7d": 7 * 86400000, "30d": 30 * 86400000 };
    const span = SPANS[currentWindow];
    const winLabel = `WINDOW ${currentWindow.toUpperCase()}`;
    $("#horizon").textContent = !m.oldest
      ? "AWAITING DATA"
      : span
        ? `HORIZON ${currentWindow === "24h" ? localStamp(stats.generated_at - span) : localDate(stats.generated_at - span)} → NOW · ${winLabel}`
        : `HORIZON ${localDate(m.oldest)} → ${localDate(m.newest)} · ${winLabel}`;
    $("#foot-updated").textContent = `REFRESHED ${localStamp(stats.generated_at)}`;
  }

  // ── MRR ───────────────────────────────────────────────────────────────
  // Every live subscription normalised to a month, plus 90 days of history.
  // Like the subscriber panel this is state, not flow, so it ignores the
  // window selector.

  const SPARK_W = 320;
  const SPARK_H = 78;

  function renderMrr() {
    const m = stats.mrr;
    if (!m) return;

    $("#mrr-value").textContent = usd(m.current_usd);
    $("#mrr-arr").textContent = usd(m.current_usd * 12);
    $("#mrr-subs").textContent = num(m.subscriptions);
    $("#mrr-risk").textContent = "−" + usd(m.lapsing_usd);
    $("#mrr-risk").classList.toggle("mono-amber", m.lapsing_usd > 0);

    // The curve begins where the data does, not 90 days back: Overflight's
    // first conversion is the first non-zero point, and a long flat run-up
    // before it would just squash the part worth looking at.
    const all = m.trend || [];
    const firstLive = all.findIndex((p) => p.subs > 0);
    const trend = firstLive === -1 ? [] : all.slice(firstLive);

    const line = $("#mrr-line");
    const area = $("#mrr-area");
    const head = $("#mrr-head");
    if (trend.length < 2) {
      line.setAttribute("points", "");
      area.setAttribute("d", "");
      head.setAttribute("cx", "-10");
      $("#mrr-axis-from").textContent = "";
      $("#mrr-axis-peak").textContent = trend.length ? usd(trend[0].usd) : "AWAITING FIRST RENEWAL";
      return;
    }

    // Zero-based, so the height of the curve reads as the size of the number
    // rather than as the size of its recent wobble.
    const peak = Math.max(...trend.map((p) => p.usd), 1e-9);
    const x = (i) => (i / (trend.length - 1)) * SPARK_W;
    const y = (v) => SPARK_H - 3 - (v / peak) * (SPARK_H - 8);
    const pts = trend.map((p, i) => `${x(i).toFixed(1)},${y(p.usd).toFixed(1)}`);

    line.setAttribute("points", pts.join(" "));
    area.setAttribute("d", `M0,${SPARK_H} L${pts.join(" L")} L${SPARK_W},${SPARK_H} Z`);
    head.setAttribute("cx", SPARK_W);
    head.setAttribute("cy", y(trend[trend.length - 1].usd));

    $("#mrr-axis-from").textContent = localDate(trend[0].t);
    $("#mrr-axis-peak").textContent = `PEAK ${usd(peak)}`;
  }

  // ── subscriber base ───────────────────────────────────────────────────
  // How many people are paying for each plan right now. Deliberately outside
  // the window selector — it's a headcount, not a flow, and it would be a lie
  // for it to change when someone clicks 24H.

  // "co.dgrlabs.overflight.pro.yearly.v2" → "PRO · YEARLY". Derived rather
  // than mapped, so a new plan names itself the day it first sells.
  function planLabel(bundleId, productId) {
    const tail = productId.startsWith(bundleId + ".")
      ? productId.slice(bundleId.length + 1)
      : productId;
    const parts = tail.split(".").filter((p) => p && !/^v\d+$/i.test(p));
    return (parts.join(" · ") || productId).toUpperCase();
  }

  // Apple's billing periods land close enough to exact that snapping to the
  // nearest known one beats trying to read the intent out of a product id.
  const PERIODS = [[365, "yr"], [182, "6mo"], [90, "3mo"], [31, "mo"], [7, "wk"]];
  function periodSuffix(days) {
    if (!days) return "";
    const best = PERIODS.reduce((a, b) =>
      Math.abs(days - b[0]) < Math.abs(days - a[0]) ? b : a
    );
    return "/" + best[1];
  }

  // A product's headline counts, built from what it actually sells rather than
  // from a fixed template: a subscription-only product should not carry an
  // "0 UNLOCKS", and an unlock-only product should not carry "0 PAYING · $0.00
  // MRR", which reads as a business doing badly rather than one shaped
  // differently.
  function tally(s) {
    const parts = [];
    if (s.paying) parts.push(`<b>${num(s.paying)}</b> PAYING`);
    if (s.trialing) parts.push(`<span class="pending">${num(s.trialing)} IN TRIAL</span>`);
    if (s.unlock_owners) parts.push(`<b>${num(s.unlock_owners)}</b> UNLOCKS`);
    return parts.join(" · ");
  }

  function renderSubscribers() {
    // By total customers, so a product that sells only unlocks ranks on its own
    // terms rather than sinking below every subscription product on a paying
    // count it can never have.
    const products = Object.entries(stats.subscribers || {})
      .filter(([, s]) => s.plans.length)
      .sort((a, b) => b[1].paying + b[1].unlock_owners - (a[1].paying + a[1].unlock_owners));

    if (!products.length) {
      $("#subs").innerHTML = `<div class="chat-hello">NO CUSTOMERS YET</div>`;
      return;
    }

    $("#subs").innerHTML = products
      .map(([id, s]) => {
        // Bars are scaled within a product, not across all of them: the
        // question a plan row answers is "which plan are people on", and
        // a shared scale would flatten a small app next to a large one.
        const maxCount = Math.max(1, ...s.plans.map((p) => p.count));
        const rows = s.plans
          .map((p) => {
            const unlock = p.kind === "unlock";
            const pct = p.count > 0 ? Math.max(2, (p.count / maxCount) * 100) : 0;
            const price =
              p.list_usd == null
                ? "—"
                : unlock
                  ? `${usd(p.list_usd)} once`
                  : `${usd(p.list_usd)}${periodSuffix(p.period_days)}`;

            const notes = [];
            if (unlock) {
              // No MRR line, and deliberately no substitute for one: a lifetime
              // unlock is revenue that already happened, and dividing it over
              // some assumed lifespan would invent a recurring figure the data
              // does not have.
              notes.push(`<span class="unlock-tag">ONE-TIME · NO MRR</span>`);
              notes.push(`${usd(p.gross_usd)} gross`);
              // Apple's own post-commission number, straight from the sales
              // reports — not gross × 0.85.
              notes.push(`${usd(p.proceeds_usd)} net`);
              // Comps and offer codes both land here: a unit Apple reported at
              // zero proceeds. "codes" would be too narrow a word for a press
              // copy or a family gift.
              if (p.offer_code) notes.push(`free <b>${num(p.offer_code)}</b>`);
            } else {
              notes.push(`<span class="mrr-tag">${usd(p.mrr_usd)} MRR</span>`);
              notes.push(`renewing <b>${num(p.paying - p.lapsing)}</b>`);
              if (p.lapsing) notes.push(`<span class="warn">lapsing <b>${num(p.lapsing)}</b></span>`);
              if (p.offer_code) notes.push(`codes <b>${num(p.offer_code)}</b>`);
            }
            if (p.trialing) notes.push(`<span class="pending">+${num(p.trialing)} in trial</span>`);
            if (p.unknown_fx) notes.push(`<span class="warn">fx? ${num(p.unknown_fx)}</span>`);

            return `
            <div class="plan-row${unlock ? " unlock" : ""}">
              <div class="plan-id">
                <div class="plan-name">${planLabel(id, p.product_id)}</div>
                <div class="plan-price">${price}</div>
              </div>
              <div class="plan-data">
                <div class="plan-bar-row">
                  <div class="plan-bar-track"><div class="plan-bar" style="width:${pct}%"></div></div>
                  <div class="plan-count">${num(p.count)}</div>
                </div>
                <div class="plan-stats">${notes
                  .map((n) => `<span class="stat">${n}</span>`)
                  .join("")}</div>
              </div>
            </div>`;
          })
          .join("");

        return `
        <div class="subs-group">
          <div class="subs-head">
            <span class="subs-app">${s.name}</span>
            <span class="subs-tally">
              ${tally(s)}
              ${s.paying ? `<span class="subs-rate">${usd(s.mrr_usd)} MRR</span>` : ""}
            </span>
          </div>
          ${rows}
        </div>`;
      })
      .join("");
  }

  // ── demo drills ───────────────────────────────────────────────────────
  // Footer triggers that replay the celebration/alarm fx without real money —
  // same events the feed dispatches, so a demo shows exactly what a live
  // sale or refund looks like.

  $("#drill-sale").addEventListener("click", () => {
    document.dispatchEvent(new CustomEvent("cc:chaching", { detail: { label: "+$9.99 USD" } }));
  });

  $("#drill-refund").addEventListener("click", () => {
    document.dispatchEvent(new CustomEvent("cc:alert", { detail: { label: "−$9.99 USD" } }));
  });

  function describe(ev) {
    const t = ev.notification_type;
    const s = ev.subtype;
    const map = {
      "SUBSCRIBED:INITIAL_BUY": ev.offer_discount_type === "FREE_TRIAL" ? "Trial started" : "New subscription",
      "SUBSCRIBED:RESUBSCRIBE": "Resubscribed",
      DID_RENEW: "Renewed",
      ONE_TIME_CHARGE: "Purchase",
      "OFFER_REDEEMED:INITIAL_BUY": "Offer redeemed",
      "OFFER_REDEEMED:RESUBSCRIBE": "Resubscribed (offer)",
      REFUND: "Refund",
      REFUND_REVERSED: "Refund reversed",
      EXPIRED: "Expired",
      DID_FAIL_TO_RENEW: "Renewal failed",
      GRACE_PERIOD_EXPIRED: "Grace period over",
      "DID_CHANGE_RENEWAL_STATUS:AUTO_RENEW_ENABLED": "Auto-renew on",
      "DID_CHANGE_RENEWAL_STATUS:AUTO_RENEW_DISABLED": "Auto-renew off",
      DID_CHANGE_RENEWAL_PREF: "Plan changed",
      REVOKE: "Family share revoked",
      TEST: "Test ping",
    };
    return map[`${t}:${s}`] || map[t] || t;
  }

  // ── chat ──────────────────────────────────────────────────────────────

  /* Continuity is a session id, not a replayed transcript.
   *
   * The console used to POST the whole conversation every turn, because the
   * Worker was calling the Anthropic API and the API is stateless. It now
   * proxies to Claude Code on bigiron, which keeps the conversation itself and
   * resumes it by id — so we send one message and the id we were given back.
   * That also keeps the (large) CLAUDE.md prefix warm in the prompt cache
   * instead of re-reading it cold on every question.
   *
   * The id outlives a reload but not a long gap: resuming yesterday's thread
   * drags yesterday's context back for no benefit. */
  const CHAT_SESSION_TTL_MS = 6 * 60 * 60 * 1000;
  let chatSession = null;
  let chatBusy = false;
  try {
    const saved = JSON.parse(localStorage.getItem("chaching.chat") || "null");
    if (saved && Date.now() - saved.at < CHAT_SESSION_TTL_MS) chatSession = saved.id;
  } catch {}

  function saveChatSession() {
    try {
      if (chatSession) {
        localStorage.setItem(
          "chaching.chat",
          JSON.stringify({ id: chatSession, at: Date.now() })
        );
      } else {
        localStorage.removeItem("chaching.chat");
      }
    } catch {}
  }

  $("#chat-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const text = $("#chat-text").value.trim();
    if (!text || chatBusy) return;
    $("#chat-text").value = "";
    sendChat(text);
  });

  function chatAppend(el) {
    const log = $("#chat-log");
    log.appendChild(el);
    log.scrollTop = log.scrollHeight;
  }

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  async function sendChat(text) {
    chatBusy = true;
    $("#chat-send").disabled = true;

    chatAppend(el("div", "msg msg-user", text));

    const bubble = el("div", "msg msg-assistant streaming");
    chatAppend(bubble);
    let assistantText = "";

    try {
      const resp = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text, session_id: chatSession }),
      });
      if (!resp.ok || !resp.body) throw new Error(`chat ${resp.status}`);

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n\n");
        buffer = lines.pop();
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          let event;
          try {
            event = JSON.parse(line.slice(6));
          } catch {
            continue;
          }
          if (event.type === "text") {
            assistantText += event.text;
            bubble.innerHTML = renderMarkdown(assistantText);
            bubble.classList.add("streaming");
            $("#chat-log").scrollTop = $("#chat-log").scrollHeight;
          } else if (event.type === "tool") {
            // The bridge reports every tool call, not just SQL. For the
            // analyst that is nearly always a ccq invocation, so show the
            // command itself — it reads as the query it is.
            const q = el("div", "msg msg-tool", event.brief || event.name);
            $("#chat-log").insertBefore(q, bubble);
            $("#chat-log").scrollTop = $("#chat-log").scrollHeight;
          } else if (event.type === "session") {
            chatSession = event.id;
            saveChatSession();
          } else if (event.type === "error") {
            chatAppend(el("div", "msg msg-error", "⚠ " + event.error));
          }
        }
      }
    } catch (e) {
      chatAppend(el("div", "msg msg-error", "⚠ LINK FAILURE: " + e.message));
    } finally {
      bubble.classList.remove("streaming");
      if (!assistantText) bubble.remove();
      chatBusy = false;
      $("#chat-send").disabled = false;
      $("#chat-text").focus();
    }
  }

  // ── minimal markdown (paragraphs, bold, code, tables, lists) ─────────

  function escapeHtml(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function inlineMd(s) {
    return escapeHtml(s)
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/`([^`]+)`/g, "<code>$1</code>");
  }

  function renderMarkdown(src) {
    const lines = src.split("\n");
    const out = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];

      if (line.startsWith("```")) {
        const code = [];
        i++;
        while (i < lines.length && !lines[i].startsWith("```")) code.push(lines[i++]);
        i++; // closing fence
        out.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`);
        continue;
      }

      if (line.includes("|") && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1]) && lines[i + 1].includes("-")) {
        const parseRow = (l) => l.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map((c) => inlineMd(c.trim()));
        const header = parseRow(line);
        i += 2;
        const rows = [];
        while (i < lines.length && lines[i].includes("|")) rows.push(parseRow(lines[i++]));
        out.push(
          `<table><thead><tr>${header.map((h) => `<th>${h}</th>`).join("")}</tr></thead>` +
            `<tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody></table>`
        );
        continue;
      }

      if (/^\s*[-*] /.test(line)) {
        const items = [];
        while (i < lines.length && /^\s*[-*] /.test(lines[i])) {
          items.push(`<li>${inlineMd(lines[i].replace(/^\s*[-*] /, ""))}</li>`);
          i++;
        }
        out.push(`<ul>${items.join("")}</ul>`);
        continue;
      }

      if (/^#{1,4} /.test(line)) {
        out.push(`<p><strong>${inlineMd(line.replace(/^#{1,4} /, ""))}</strong></p>`);
        i++;
        continue;
      }

      if (line.trim() === "") {
        i++;
        continue;
      }

      const para = [line];
      i++;
      while (i < lines.length && lines[i].trim() !== "" && !/^([-*] |#|```|.*\|)/.test(lines[i])) {
        para.push(lines[i++]);
      }
      out.push(`<p>${inlineMd(para.join(" "))}</p>`);
    }
    return out.join("");
  }

  // ── boot ──────────────────────────────────────────────────────────────

  (async () => {
    try {
      const resp = await fetch("/api/stats");
      if (!resp.ok) throw new Error(`stats ${resp.status}`);
      stats = await resp.json();
      render();
    } catch (e) {
      // No gate to fall back to any more, so come up anyway with the link
      // marked down — the refresh below is the recovery path.
      console.error(e);
      $("#link-dot").className = "dot dot-down";
      $("#link-state").textContent = "NO LINK";
    }
    revealConsole();
    refreshTimer = setTimeout(loadStats, FULL_REFRESH_MS);
    startPulse();
  })();
})();
