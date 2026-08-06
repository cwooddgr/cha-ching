// REV-9000 cinematic layer — boot sequence, particles, lens flares,
// targeting reticle, rail readouts. Pure decoration: app.js never depends on
// this file existing; everything here is safe to fail.

(() => {
  "use strict";

  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const finePointer = matchMedia("(pointer: fine)").matches;

  // ── boot sequence ─────────────────────────────────────────────────────
  // Played once, when app.js reveals the console. Short on purpose — this
  // runs on every reload of a dashboard people actually use.

  const BOOT_LINES = [
    "REV-9000 TELEMETRY CORE · v9.0",
    "▸ establishing secure uplink ........... OK",
    "▸ decrypting revenue stream ............ OK",
    "▸ calibrating instrumentation .......... OK",
    "▸ ALL SYSTEMS NOMINAL",
  ];

  let booted = false;

  function boot() {
    if (booted) return;
    booted = true;

    if (reduced || document.visibilityState === "hidden") {
      document.body.classList.add("booted");
      return;
    }

    const ov = document.createElement("div");
    ov.id = "boot";
    ov.innerHTML =
      `<div class="boot-inner">` +
      BOOT_LINES.map((l, i) => `<div class="boot-line" data-i="${i}">${l}</div>`).join("") +
      `<div class="boot-bar"><i></i></div>` +
      `</div>`;
    document.body.appendChild(ov);

    const lines = ov.querySelectorAll(".boot-line");
    const STEP = 230;
    lines.forEach((l, i) => setTimeout(() => l.classList.add("on"), 120 + i * STEP));

    const finish = () => {
      if (!ov.parentNode) return;
      ov.classList.add("boot-out");
      document.body.classList.add("booted");
      setTimeout(() => ov.remove(), 650);
      setTimeout(() => sweepFlare(0.9), 250);
    };
    // Click/keypress skips straight to the console.
    ov.addEventListener("pointerdown", finish);
    addEventListener("keydown", finish, { once: true });
    setTimeout(finish, 120 + lines.length * STEP + 520);
  }

  // ── lens flares ───────────────────────────────────────────────────────

  const flareLayer = document.getElementById("flare-layer");

  function sweepFlare(strength = 1) {
    if (reduced || !flareLayer) return;
    const f = document.createElement("div");
    f.className = "flare-sweep";
    f.style.opacity = String(strength);
    flareLayer.appendChild(f);
    f.addEventListener("animationend", () => f.remove());
    setTimeout(() => f.remove(), 2000); // belt and braces
  }

  // A faint glint wandering by every so often keeps the frame alive without
  // demanding attention.
  function scheduleGlint() {
    if (reduced) return;
    setTimeout(() => {
      if (document.visibilityState === "visible") sweepFlare(0.28);
      scheduleGlint();
    }, 34000 + Math.random() * 32000);
  }
  scheduleGlint();

  // ── cash register ─────────────────────────────────────────────────────
  // A real one: public-domain recording from Wikimedia Commons
  // ("File:Cash register.ogg"), trimmed/normalized, decoded into a buffer so
  // playback lands sample-accurate with the stamp. Browsers gate audio behind
  // a user gesture, so the context unlocks on the first interaction; the SND
  // toggle in the masthead mutes it (persisted).

  const SOUND_KEY = "cc_sound";
  let soundOn = true;
  try { soundOn = (localStorage.getItem(SOUND_KEY) ?? "on") === "on"; } catch { /* default on */ }

  let audioCtx = null;
  function ensureCtx() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    if (!audioCtx) audioCtx = new AC();
    if (audioCtx.state === "suspended") audioCtx.resume();
    return audioCtx;
  }
  ["pointerdown", "keydown"].forEach((t) =>
    addEventListener(t, () => {
      if (!soundOn) return;
      ensureCtx();
      loadChaChing(); // decode ahead of time so the first hit isn't late
    }, { once: true, capture: true }));

  let chaChingBuf = null;
  let chaChingFetch = null;
  function loadChaChing() {
    if (!audioCtx) return Promise.resolve();
    if (chaChingFetch) return chaChingFetch;
    chaChingFetch = fetch("/chaching.mp3")
      .then((r) => r.arrayBuffer())
      .then((b) => new Promise((res, rej) => audioCtx.decodeAudioData(b, res, rej)))
      .then((buf) => { chaChingBuf = buf; })
      .catch(() => { chaChingFetch = null; }); // transient — retry on next play
    return chaChingFetch;
  }

  function chaChingSound() {
    if (!soundOn) return;
    const ctx = ensureCtx();
    if (!ctx || ctx.state !== "running") return;
    const play = () => {
      if (!chaChingBuf) return;
      const src = ctx.createBufferSource();
      src.buffer = chaChingBuf;
      const g = ctx.createGain();
      g.gain.value = 0.9;
      src.connect(g); g.connect(ctx.destination);
      src.start();
    };
    if (chaChingBuf) play();
    else loadChaChing().then(play);
  }

  const sndBtn = document.getElementById("snd");
  const sndState = document.getElementById("snd-state");
  function paintSnd() {
    if (!sndBtn) return;
    sndBtn.classList.toggle("off", !soundOn);
    if (sndState) sndState.textContent = soundOn ? "ON" : "OFF";
  }
  paintSnd();
  if (sndBtn) sndBtn.addEventListener("click", () => {
    soundOn = !soundOn;
    try { localStorage.setItem(SOUND_KEY, soundOn ? "on" : "off"); } catch { /* session-only */ }
    paintSnd();
    if (soundOn) chaChingSound(); // the preview doubles as confirmation
  });

  // ── cha-ching moment ──────────────────────────────────────────────────
  // app.js dispatches cc:chaching when fresh production revenue lands.

  document.addEventListener("cc:chaching", (e) => {
    sweepFlare(1);
    const hero = document.getElementById("hero-panel");
    if (hero) {
      hero.classList.remove("flash");
      void hero.offsetWidth; // restart the animation
      hero.classList.add("flash");
    }
    const hal = document.getElementById("hal");
    if (hal) {
      hal.classList.remove("alert");
      void hal.offsetWidth;
      hal.classList.add("alert");
    }
    if (reduced) return;
    const stamp = document.createElement("div");
    stamp.className = "chaching-stamp";
    const label = (e.detail && e.detail.label) || "REVENUE EVENT";
    stamp.innerHTML = `<span class="stamp-main">CHA-CHING</span><span class="stamp-sub">${label}</span>`;
    document.body.appendChild(stamp);
    stamp.addEventListener("animationend", () => stamp.remove());
    setTimeout(() => stamp.remove(), 3000);
  });

  // ── particle field ────────────────────────────────────────────────────
  // Slow-drifting motes plus the occasional horizontal data streak.

  const cvs = document.getElementById("particles");
  if (cvs && !reduced) {
    const ctx = cvs.getContext("2d");
    let w = 0, h = 0, dpr = 1;
    let motes = [];
    let streaks = [];
    let last = performance.now();
    let running = false;

    function resize() {
      dpr = Math.min(devicePixelRatio || 1, 1.5);
      w = innerWidth;
      h = innerHeight;
      cvs.width = Math.round(w * dpr);
      cvs.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const n = w < 700 ? 26 : 60;
      motes = Array.from({ length: n }, () => ({
        x: Math.random() * w,
        y: Math.random() * h,
        r: 0.4 + Math.random() * 1.3,
        vy: -(4 + Math.random() * 14),
        vx: (Math.random() - 0.5) * 4,
        a: 0.08 + Math.random() * 0.3,
        tw: Math.random() * Math.PI * 2,
      }));
    }

    function spawnStreak() {
      streaks.push({
        x: -140,
        y: Math.random() * h * 0.85,
        v: 900 + Math.random() * 900,
        len: 90 + Math.random() * 120,
        a: 0.25 + Math.random() * 0.3,
      });
      streakTimer = 5000 + Math.random() * 9000;
    }
    let streakTimer = 4000;

    function frame(now) {
      if (!running) return;
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      ctx.clearRect(0, 0, w, h);

      for (const p of motes) {
        p.y += p.vy * dt;
        p.x += p.vx * dt;
        p.tw += dt * 2;
        if (p.y < -4) { p.y = h + 4; p.x = Math.random() * w; }
        if (p.x < -4) p.x = w + 4;
        if (p.x > w + 4) p.x = -4;
        const a = p.a * (0.6 + 0.4 * Math.sin(p.tw));
        ctx.fillStyle = `rgba(53, 224, 255, ${a.toFixed(3)})`;
        ctx.fillRect(p.x, p.y, p.r, p.r);
      }

      streakTimer -= dt * 1000;
      if (streakTimer <= 0) spawnStreak();
      streaks = streaks.filter((s) => s.x < w + 200);
      for (const s of streaks) {
        s.x += s.v * dt;
        const g = ctx.createLinearGradient(s.x - s.len, s.y, s.x, s.y);
        g.addColorStop(0, "rgba(53,224,255,0)");
        g.addColorStop(1, `rgba(53,224,255,${s.a})`);
        ctx.strokeStyle = g;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(s.x - s.len, s.y);
        ctx.lineTo(s.x, s.y);
        ctx.stroke();
      }

      requestAnimationFrame(frame);
    }

    function setRunning(on) {
      if (on === running) return;
      running = on;
      if (on) { last = performance.now(); requestAnimationFrame(frame); }
    }

    addEventListener("resize", resize);
    document.addEventListener("visibilitychange", () =>
      setRunning(document.visibilityState === "visible"));
    resize();
    setRunning(document.visibilityState === "visible");
  }

  // ── targeting reticle ─────────────────────────────────────────────────
  // Crosshair + coordinate readout trailing the pointer. Desktop only.

  const ret = document.getElementById("reticle");
  if (ret && finePointer && !reduced) {
    const hLine = ret.querySelector(".ret-h");
    const vLine = ret.querySelector(".ret-v");
    const read = ret.querySelector(".ret-read");
    let tx = -100, ty = -100, x = -100, y = -100, live = false;

    addEventListener("mousemove", (e) => {
      tx = e.clientX;
      ty = e.clientY;
      if (!live) {
        live = true;
        ret.classList.add("on");
        requestAnimationFrame(track);
      }
    });

    function track() {
      x += (tx - x) * 0.22;
      y += (ty - y) * 0.22;
      hLine.style.transform = `translateY(${y.toFixed(1)}px)`;
      vLine.style.transform = `translateX(${x.toFixed(1)}px)`;
      read.style.transform = `translate(${(x + 14).toFixed(1)}px, ${(y + 14).toFixed(1)}px)`;
      read.textContent = `X:${String(Math.round(x)).padStart(4, "0")} Y:${String(Math.round(y)).padStart(4, "0")}`;
      requestAnimationFrame(track);
    }
  }

  // ── rail readouts ─────────────────────────────────────────────────────
  // Meaningless hex chatter. That is the point.

  const railL = document.getElementById("rail-hex-l");
  const railR = document.getElementById("rail-hex-r");
  if ((railL || railR) && !reduced) {
    const hex = () =>
      Array.from({ length: 4 }, () =>
        Math.floor(Math.random() * 0xffff).toString(16).padStart(4, "0")).join(" · ");
    const tick = () => {
      if (document.visibilityState === "visible") {
        if (railL) railL.textContent = hex().toUpperCase();
        if (railR) railR.textContent = hex().toUpperCase();
      }
    };
    tick();
    setInterval(tick, 1700);
  }

  window.CCFX = { boot, sweepFlare };
})();
