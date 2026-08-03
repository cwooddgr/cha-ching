// CHA-CHING console — auth, stats rendering, event feed, analyst chat.

(() => {
  "use strict";

  const $ = (sel) => document.querySelector(sel);

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
    if (message) $("#auth-error").textContent = message;
    $("#auth-secret").focus();
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
      $("#auth").classList.add("hidden");
      $("#console").classList.remove("hidden");
      loadStats();
    } catch {
      $("#auth-error").textContent = "LINK FAILURE";
    }
  });

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
    refreshTimer = setTimeout(loadStats, 120000);
  }

  document.querySelectorAll(".window-select button").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".window-select button").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      currentWindow = btn.dataset.window;
      render();
    });
  });

  function render() {
    if (!stats) return;
    const win = stats.windows[currentWindow];
    if (!win) return;
    const t = win.total;

    // hero
    $("#hero-revenue").textContent = usd(t.revenue_usd);
    $("#hero-proceeds").textContent = usd(t.revenue_usd * 0.85);
    $("#hero-refunds").textContent = "−" + usd(t.refunds_usd);

    // trial conversion gauge: conversions vs trial starts in the window
    const convRate = t.trial_starts > 0 ? Math.min(1, t.trial_conversions / t.trial_starts) : null;
    const arc = $("#gauge-arc");
    const circumference = 2 * Math.PI * 70;
    arc.setAttribute("stroke-dasharray", circumference);
    arc.style.strokeDashoffset = convRate == null ? circumference : circumference * (1 - convRate);
    $("#gauge-pct").textContent = convRate == null ? "—" : Math.round(convRate * 100) + "%";

    // tiles
    const tiles = [
      { label: "NEW SUBS · PAID", value: num(t.new_subs) },
      { label: "TRIAL STARTS", value: num(t.trial_starts) },
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
                  <span>trials <b>${num(a.trial_starts)}</b>▸<b>${num(a.trial_conversions)}</b></span>
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
        return `
        <div class="feed-row">
          <span class="feed-time">${utcStamp(ev.signed_date)}</span>
          <span class="feed-app">${APP_CODES[ev.bundle_id] || "—"}</span>
          <span class="feed-desc ${cls}"><span class="glyph">${glyph}</span>${desc}${sandbox ? " [SBX]" : ""}</span>
          <span class="feed-amt ${sandbox ? "sandbox" : ""}">${amt}</span>
        </div>`;
      })
      .join("");
    $("#feed-note").textContent = `LAST ${feed.length}`;

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
      $("#console").classList.remove("hidden");
      render();
      refreshTimer = setTimeout(loadStats, 120000);
    } catch {
      showAuth("LINK FAILURE — RETRY");
    }
  })();
})();
