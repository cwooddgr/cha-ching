// REV-9000 console — auth, stats rendering, event feed, analyst chat.

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

  function utcStamp(ms) {
    const d = new Date(ms);
    const p = (x) => String(x).padStart(2, "0");
    return `${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}Z`;
  }

  function utcDate(ms) {
    const d = new Date(ms);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
  }

  // ── clock ─────────────────────────────────────────────────────────────

  setInterval(() => {
    const d = new Date();
    const p = (x) => String(x).padStart(2, "0");
    $("#clock").textContent = `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
  }, 1000);

  // ── auth ──────────────────────────────────────────────────────────────

  function showAuth(message) {
    $("#console").classList.add("hidden");
    $("#auth").classList.remove("hidden");
    document.body.classList.add("booted"); // the auth gate needs no boot reel
    if (message) $("#auth-error").textContent = message;
    $("#auth-secret").focus();
  }

  // Hand the reveal to the fx layer (boot sequence), with a fallback so the
  // console still appears if fx.js failed to load or never flips the class.
  function revealConsole() {
    $("#auth").classList.add("hidden");
    $("#console").classList.remove("hidden");
    if (window.CCFX) window.CCFX.boot();
    setTimeout(() => document.body.classList.add("booted"), 3000);
  }

  $("#auth-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    $("#auth-error").textContent = "";
    const secret = $("#auth-secret").value;
    try {
      const resp = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ secret }),
      });
      if (!resp.ok) {
        $("#auth-error").textContent = "ACCESS DENIED";
        return;
      }
      revealConsole();
      loadStats();
      startPulse();
    } catch {
      $("#auth-error").textContent = "LINK FAILURE";
    }
  });

  let pulseTimer = null;
  function startPulse() {
    if (pulseTimer) return;
    pulseTimer = setInterval(pulse, PULSE_MS);
  }

  // ── stats ─────────────────────────────────────────────────────────────

  async function loadStats() {
    try {
      const resp = await fetch("/api/stats");
      if (resp.status === 401) {
        showAuth("");
        return;
      }
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
    $("#hero-proceeds").textContent = usd(t.revenue_usd * 0.85);
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

    // feed
    const feed = stats.feed || [];
    const freshRevenue = []; // fresh production money — the fx layer celebrates these
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
        return `
        <div class="feed-row${fresh ? " fresh" : ""}">
          <span class="feed-time">${utcStamp(ev.signed_date)}</span>
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

    // meta
    const m = stats.meta;
    $("#meta-events").textContent = `${num(m.total_events)} EVT`;
    $("#horizon").textContent = m.oldest
      ? `HORIZON ${utcDate(m.oldest)} → ${utcDate(m.newest)} · WINDOW ${currentWindow.toUpperCase()}`
      : "AWAITING DATA";
    $("#foot-updated").textContent = `REFRESHED ${utcStamp(stats.generated_at)}`;
  }

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

  const chatHistory = [];
  let chatBusy = false;

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

    chatHistory.push({ role: "user", content: text });
    chatAppend(el("div", "msg msg-user", text));

    const bubble = el("div", "msg msg-assistant streaming");
    chatAppend(bubble);
    let assistantText = "";

    try {
      const resp = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: chatHistory }),
      });
      if (resp.status === 401) {
        showAuth("SESSION EXPIRED");
        return;
      }
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
            const q = el("div", "msg msg-tool", event.sql);
            $("#chat-log").insertBefore(q, bubble);
            $("#chat-log").scrollTop = $("#chat-log").scrollHeight;
          } else if (event.type === "error") {
            chatAppend(el("div", "msg msg-error", "⚠ " + event.error));
          }
        }
      }
    } catch (e) {
      chatAppend(el("div", "msg msg-error", "⚠ LINK FAILURE: " + e.message));
    } finally {
      bubble.classList.remove("streaming");
      if (assistantText) {
        chatHistory.push({ role: "assistant", content: assistantText });
      } else {
        bubble.remove();
      }
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
      if (resp.status === 401) {
        showAuth("");
        return;
      }
      stats = await resp.json();
      revealConsole();
      render();
      refreshTimer = setTimeout(loadStats, FULL_REFRESH_MS);
      startPulse();
    } catch {
      showAuth("LINK FAILURE — RETRY");
    }
  })();
})();
