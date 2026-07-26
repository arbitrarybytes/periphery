/* ==========================================================================
   Periphery landing — the page is the demo.
   Cue engine mirrors the app's overlay: comet (tier 1), edge glow (tier 2),
   bottom glow (tier 3). Honors prefers-reduced-motion the same way the app
   does: travelling cues become stationary fades.
   ========================================================================== */

(() => {
  "use strict";

  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const stage = document.getElementById("cueStage");

  const COLORS = {
    t1: "#ff9e64",
    t2: "#38c5ff",
    t3: "#6ee7c8",
  };

  /* ---------------- Starfield ---------------- */

  const starfield = document.getElementById("starfield");
  const starCount = window.innerWidth < 640 ? 55 : 110;
  const frag = document.createDocumentFragment();
  for (let i = 0; i < starCount; i++) {
    const s = document.createElement("span");
    s.className = "star";
    const size = Math.random() < 0.85 ? 1 + Math.random() : 2 + Math.random();
    s.style.width = s.style.height = size.toFixed(1) + "px";
    s.style.left = (Math.random() * 100).toFixed(2) + "%";
    s.style.top = (Math.random() * 100).toFixed(2) + "%";
    s.style.setProperty("--tw", (3.5 + Math.random() * 5).toFixed(1) + "s");
    s.style.setProperty("--twd", (Math.random() * 6).toFixed(1) + "s");
    s.style.setProperty("--o-min", (0.06 + Math.random() * 0.12).toFixed(2));
    s.style.setProperty("--o-max", (0.4 + Math.random() * 0.45).toFixed(2));
    if (Math.random() < 0.14) s.style.background = "#7fd8ff";
    frag.appendChild(s);
  }
  starfield.appendChild(frag);

  /* ---------------- Nav + scroll reveal ---------------- */

  const nav = document.getElementById("nav");
  addEventListener("scroll", () => nav.classList.toggle("scrolled", scrollY > 30), { passive: true });

  const revealObserver = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (e.isIntersecting) {
          e.target.classList.add("in");
          revealObserver.unobserve(e.target);
        }
      }
    },
    { threshold: 0.12, rootMargin: "0px 0px -6% 0px" }
  );
  document.querySelectorAll(".reveal").forEach((el) => revealObserver.observe(el));

  /* ---------------- Cue engine ---------------- */

  function edgeGlow(color, { duration = 2600, spread = 130 } = {}) {
    const el = document.createElement("div");
    el.className = "cue-edge";
    el.style.boxShadow = `inset 0 0 ${spread}px 26px ${hexA(color, 0.5)}, inset 0 0 44px 8px ${hexA(color, 0.35)}`;
    stage.appendChild(el);
    el.animate(
      [{ opacity: 0 }, { opacity: 1, offset: 0.3 }, { opacity: 0.85, offset: 0.6 }, { opacity: 0 }],
      { duration, easing: "ease-in-out" }
    ).onfinish = () => el.remove();
  }

  function bottomGlow(color, { duration = 4200 } = {}) {
    const el = document.createElement("div");
    el.className = "cue-bottom";
    el.style.background = `linear-gradient(to top, ${hexA(color, 0.34)}, ${hexA(color, 0.1)} 45%, transparent)`;
    stage.appendChild(el);
    el.animate(
      [{ opacity: 0 }, { opacity: 1, offset: 0.35 }, { opacity: 1, offset: 0.6 }, { opacity: 0 }],
      { duration, easing: "ease-in-out" }
    ).onfinish = () => el.remove();
  }

  function comet(color = COLORS.t1) {
    if (reducedMotion.matches) {
      // The app's contract: travelling cues become stationary fades.
      edgeGlow(color, { duration: 1800, spread: 160 });
      return;
    }
    const el = document.createElement("div");
    el.className = "cue-comet";
    el.style.setProperty("--comet-color", color);
    el.innerHTML = '<span class="comet-tail"></span><span class="comet-head"></span>';
    stage.appendChild(el);

    const w = innerWidth, h = innerHeight;
    const startY = h * (0.12 + Math.random() * 0.2);
    const endY = startY + h * (0.28 + Math.random() * 0.22);
    const angle = (Math.atan2(endY - startY, w + 480) * 180) / Math.PI;
    el.style.transform = `rotate(${angle}deg)`;

    el.animate(
      [
        { transform: `translate(-280px, ${startY}px) rotate(${angle}deg)`, opacity: 0 },
        { opacity: 1, offset: 0.12 },
        { opacity: 1, offset: 0.82 },
        { transform: `translate(${w + 200}px, ${endY}px) rotate(${angle}deg)`, opacity: 0 },
      ],
      { duration: 1500, easing: "cubic-bezier(0.4, 0, 0.6, 1)" }
    ).onfinish = () => el.remove();

    // A fast pulse rides along with the comet, per the attention hierarchy.
    edgeGlow(color, { duration: 1600, spread: 90 });
  }

  function hexA(hex, alpha) {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
  }

  /**
   * The agent beacon, demo edition. In the app it never expires — it waits
   * for you to return to the keyboard. On a web page "return" is meaningless,
   * so the demo lingers ~12s, then "acknowledges": fades out like the app
   * does when you're back.
   */
  let demoBeacon = null;
  function agentBeacon() {
    if (demoBeacon) return; // one at a time, like a real completion
    const el = document.createElement("div");
    el.className = "cue-agent-demo";
    stage.appendChild(el);
    demoBeacon = el;
    setTimeout(() => {
      el.style.transition = "opacity 1.4s ease";
      el.style.opacity = "0";
      setTimeout(() => { el.remove(); demoBeacon = null; }, 1500);
    }, 12000);
  }

  const CUES = {
    comet: () => comet(COLORS.t1),
    edge: () => edgeGlow(COLORS.t2),
    bottom: () => bottomGlow(COLORS.t3),
    beacon: agentBeacon,
  };

  document.querySelectorAll("[data-cue]").forEach((btn) =>
    btn.addEventListener("click", () => CUES[btn.dataset.cue]())
  );
  document.getElementById("heroDemo").addEventListener("click", () => comet(COLORS.t2));
  document.getElementById("codeRun").addEventListener("click", () => edgeGlow(COLORS.t2));

  /* Ambient auto-demo: one comet shortly after load, then an occasional
     soft glow — infrequent on purpose. That IS the product. */
  setTimeout(() => { if (!document.hidden) comet(COLORS.t2); }, 2800);
  setInterval(() => {
    if (document.hidden) return;
    Math.random() < 0.5 ? edgeGlow(COLORS.t2, { duration: 3600, spread: 90 }) : bottomGlow(COLORS.t3, { duration: 5200 });
  }, 21000);

  /* ---------------- Demo helper: run a looping timeline while visible ------ */

  function loopWhileVisible(rootEl, runOnce, restDelay) {
    let active = false, cancelled = true, timers = [];
    const wait = (ms) => new Promise((res) => timers.push(setTimeout(res, ms)));
    async function loop() {
      while (active) {
        await runOnce(wait);
        if (!active) break;
        await wait(restDelay);
      }
    }
    new IntersectionObserver(
      ([e]) => {
        if (e.isIntersecting && cancelled) {
          cancelled = false; active = true; loop();
        } else if (!e.isIntersecting && active) {
          active = false; cancelled = true;
          timers.forEach(clearTimeout); timers = [];
        }
      },
      { threshold: 0.35 }
    ).observe(rootEl);
  }

  /* ---------------- Slack Tide demo ---------------- */

  const tideTyped = document.getElementById("tideTyped");
  const tideHeld = document.getElementById("tideHeld");
  const tideStatus = document.getElementById("tideStatus");
  const tidePills = document.getElementById("tidePills");

  const TIDE_LINE = "const verdict = validateCuePayload(req.body);";
  const TIDE_CUES = [
    { at: 10, color: COLORS.t2 },
    { at: 22, color: "#fc6d26" },
    { at: 34, color: COLORS.t3 },
  ];
  const TIDE_PILLS = [
    { text: "gitlab · pipeline #4183 passed", color: "#fc6d26" },
    { text: "outlook · standup in 10 min", color: COLORS.t2 },
    { text: "+1 more", color: COLORS.t3 },
  ];

  loopWhileVisible(document.getElementById("tideDemo"), async (wait) => {
    tideTyped.textContent = "";
    tideHeld.innerHTML = "";
    tidePills.innerHTML = "";
    tideStatus.textContent = " ";
    await wait(600);

    for (let i = 0; i < TIDE_LINE.length; i++) {
      tideTyped.textContent += TIDE_LINE[i];
      const cue = TIDE_CUES.find((c) => c.at === i);
      if (cue) {
        const dot = document.createElement("span");
        dot.className = "held-dot";
        dot.style.setProperty("--held-c", cue.color);
        tideHeld.appendChild(dot);
        tideStatus.textContent = `keystroke burst — holding ${tideHeld.children.length} cue${tideHeld.children.length > 1 ? "s" : ""}`;
      }
      await wait(40 + Math.random() * 90);
    }

    await wait(1400);
    tideStatus.textContent = "micro-pause detected — releasing";
    await wait(500);
    tideHeld.innerHTML = "";
    for (const p of TIDE_PILLS) {
      const pill = document.createElement("span");
      pill.className = "tide-pill";
      pill.style.setProperty("--pill-c", p.color);
      pill.textContent = p.text;
      tidePills.appendChild(pill);
      await wait(650);
    }
    await wait(2400);
  }, 1200);

  /* ---------------- Constellation demo ---------------- */

  const constSky = document.getElementById("constSky");
  const constLabel = document.getElementById("constLabel");
  const constSummary = document.getElementById("constSummary");

  const CONST_STARS = [
    { x: 78, y: 18, c: "#fc6d26" },
    { x: 66, y: 34, c: COLORS.t2 },
    { x: 84, y: 44, c: COLORS.t2 },
    { x: 58, y: 16, c: COLORS.t3 },
    { x: 72, y: 56, c: "#fc6d26" },
  ];

  loopWhileVisible(document.getElementById("constDemo"), async (wait) => {
    constSky.innerHTML = "";
    constSummary.classList.remove("show");
    let secs = 24 * 60 + 51;
    constLabel.textContent = "focus mode · 24:51";

    for (const st of CONST_STARS) {
      secs -= 47;
      constLabel.textContent = `focus mode · ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
      const el = document.createElement("span");
      el.className = "const-star";
      el.style.left = st.x + "%";
      el.style.top = st.y + "%";
      el.style.setProperty("--star-c", st.c);
      constSky.appendChild(el);
      await wait(1250);
    }

    await wait(1600);
    constLabel.textContent = "focus ended";
    constSky.querySelectorAll(".const-star").forEach((s) => s.classList.add("fading"));
    await wait(700);
    constSummary.classList.add("show");
    await wait(3400);
    constSummary.classList.remove("show");
  }, 1400);
})();
