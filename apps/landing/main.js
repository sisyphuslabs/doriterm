const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
const STORAGE_KEY = "doriterm-theme";

const randomHex = (bytes) =>
  Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, "0")).join(" ");

/** Runs `start` while `element` is on screen and motion is allowed; `stop` runs when either stops holding. */
function whileVisible(element, start, stop) {
  let visible = false;
  let running = false;
  const sync = () => {
    const should = visible && !reducedMotion.matches && document.visibilityState === "visible";
    element.classList.toggle("is-running", should);
    if (should && !running) start();
    if (!should && running) stop();
    running = should;
  };
  new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;
    sync();
  }).observe(element);
  reducedMotion.addEventListener("change", sync);
  document.addEventListener("visibilitychange", sync);
}

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });

/** Runs each step after the previous one settles; a rejected step (an aborted sleep) stops the rest. */
const sequence = (steps) => steps.reduce((chain, step) => chain.then(step), Promise.resolve());

/** Repeats an async scene while it is visible; leaving the screen aborts it mid-step and `reset` restores the still frame. */
function loopWhileVisible(element, scene, reset) {
  let controller;
  whileVisible(
    element,
    () => {
      controller = new AbortController();
      const { signal } = controller;
      const repeat = () => {
        if (!signal.aborted) scene(signal).then(repeat, () => {});
      };
      repeat();
    },
    () => {
      controller.abort();
      reset();
    },
  );
  reset();
}

/** Tells a live mockup which theme the page pins; "system" lets it follow prefers-color-scheme like the page. */
function postTheme(frame, choice) {
  frame.contentWindow?.postMessage({ theme: choice === "system" ? null : choice }, location.origin);
}

function setupLive() {
  const resize = new ResizeObserver((entries) => {
    for (const entry of entries) {
      const box = entry.target;
      const width = Number(getComputedStyle(box).getPropertyValue("--w"));
      box.style.setProperty("--scale", String(entry.contentRect.width / width));
    }
  });
  // The mockups carry React and the app's stylesheet. They start loading after the page itself has loaded and its
  // headline painted, and a frame the layout hides (the desktop window on phones) never loads.
  const load = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting || entry.target.offsetParent === null) continue;
        const frame = entry.target.querySelector("iframe");
        frame.src = frame.dataset.src;
        load.unobserve(entry.target);
      }
    },
    { rootMargin: "50% 0px" },
  );
  const boxes = [...document.querySelectorAll(".live")];
  // Safari has no requestIdleCallback; a timeout keeps the same "after the page" order there.
  const idle = window.requestIdleCallback ?? ((fn) => setTimeout(fn, 1));
  const start = () => idle(() => boxes.forEach((box) => load.observe(box)), { timeout: 1500 });
  if (document.readyState === "complete") start();
  else addEventListener("load", start, { once: true });
  for (const box of boxes) {
    resize.observe(box);
    const frame = box.querySelector("iframe");
    frame.addEventListener("load", () => postTheme(frame, document.documentElement.dataset.theme ?? "system"));
  }
}

function setupTheme() {
  const buttons = [...document.querySelectorAll("[data-theme-choice]")];
  const apply = (choice) => {
    for (const frame of document.querySelectorAll(".live iframe")) postTheme(frame, choice);
    if (choice === "system") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = choice;
    // Blocked site storage throws: the choice then lasts for this page only.
    try {
      if (choice === "system") localStorage.removeItem(STORAGE_KEY);
      else localStorage.setItem(STORAGE_KEY, choice);
    } catch {}
    for (const button of buttons) button.setAttribute("aria-pressed", String(button.dataset.themeChoice === choice));
  };
  apply(document.documentElement.dataset.theme ?? "system");
  for (const button of buttons) button.addEventListener("click", () => apply(button.dataset.themeChoice));
}

function setupReveal() {
  const items = document.querySelectorAll(".reveal");
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add("in");
        observer.unobserve(entry.target);
      }
    },
    { rootMargin: "0px 0px -8% 0px" },
  );
  for (const item of items) observer.observe(item);
}

function setupWire() {
  for (const stream of document.querySelectorAll("[data-stream]")) {
    const chunks = Array.from({ length: 10 }, () => randomHex(4 + Math.floor(Math.random() * 4)));
    for (const text of [...chunks, ...chunks]) {
      const span = document.createElement("span");
      span.textContent = text;
      stream.append(span);
    }
  }
}

const SESSIONS = [
  {
    command: "git status",
    output: `<span class="dim">On branch</span> main
<span class="dim">Your branch is up to date with</span> 'origin/main'.
<span class="ok">nothing to commit, working tree clean</span>`,
  },
  {
    command: "bun test",
    output: `<span class="dim">bun test v1.4.4</span>
<span class="ok">412 pass</span>
<span class="dim">0 fail</span>
<span class="dim">Ran 412 tests across 58 files.</span>`,
  },
  {
    command: "git log --oneline -3",
    output: `<span class="hl">a41c9e2</span> landing: relay and mesh sections
<span class="hl">7d0b3f1</span> pair: QR opens the web form
<span class="hl">c95e8aa</span> mesh: revoke closes sessions`,
  },
];

function setupPipe() {
  const root = document.querySelector("[data-pipe]");
  const typed = root.querySelector("[data-type]");
  const host = root.querySelector("[data-host]");
  const still = host.innerHTML;
  const prompt = '<span class="prompt">~/app $</span> ';
  loopWhileVisible(
    root,
    (signal) =>
      sequence(
        SESSIONS.flatMap((session) => [
          () => {
            typed.textContent = "";
            host.innerHTML = prompt;
            return sleep(500, signal);
          },
          ...[...session.command].map((char) => () => {
            typed.textContent += char;
            return sleep(55 + Math.random() * 60, signal);
          }),
          () => sleep(650, signal),
          () => {
            host.innerHTML = `${prompt}${session.command}`;
            return sleep(350, signal);
          },
          () => {
            host.innerHTML = `${prompt}${session.command}\n${session.output}`;
            return sleep(2600, signal);
          },
        ]),
      ),
    () => {
      typed.textContent = SESSIONS[0].command;
      host.innerHTML = still;
    },
  );
}

function setupPairing() {
  const root = document.querySelector("[data-pair]");
  const groups = [...root.querySelectorAll("[data-fp] span")];
  const fingerprint = root.querySelector("[data-fp]");
  const chip = root.querySelector("[data-pair-state]");
  const label = chip.lastChild;
  const show = (matched) => {
    fingerprint.classList.toggle("match", matched);
    label.textContent = matched ? "fingerprint matches" : "comparing fingerprint";
    chip.style.opacity = matched ? "1" : "0.7";
  };
  loopWhileVisible(
    root,
    async (signal) => {
      show(false);
      for (const group of groups) group.style.background = "";
      await sleep(1700, signal);
      await sequence(
        groups.map((group) => () => {
          group.style.background = "var(--accent-wash)";
          return sleep(120, signal);
        }),
      );
      show(true);
      for (const group of groups) group.style.background = "";
      await sleep(3000, signal);
    },
    () => show(true),
  );
}

function setupCopy() {
  const button = document.querySelector("[data-copy]");
  const label = button.querySelector("[data-copy-label]");
  const source = document.querySelector("[data-copy-source]");
  button.addEventListener("click", async () => {
    const commands = source.textContent
      .split("\n")
      .map((line) => line.replace(/^\$ /, "").replace(/\s+#.*$/, ""))
      .join("\n");
    try {
      await navigator.clipboard.writeText(commands);
      label.textContent = "Copied";
    } catch {
      label.textContent = "Select and copy";
    }
    setTimeout(() => (label.textContent = "Copy"), 1600);
  });
}

/** One coordinate of a cubic bezier at parameter t, and its derivative. */
const bezierAt = (a, b, t) => ((1 - 3 * b + 3 * a) * t + (3 * b - 6 * a)) * t * t + 3 * a * t;
const bezierSlope = (a, b, t) => 3 * (1 - 3 * b + 3 * a) * t * t + 2 * (3 * b - 6 * a) * t + 3 * a;

/** Points along a polyline at a dot pitch, with each one's fraction of the whole length. */
const dotted = (points, pitch) => {
  const out = [];
  const lengths = points.slice(1).map((p, i) => Math.hypot(p[0] - points[i][0], p[1] - points[i][1]));
  const total = lengths.reduce((a, b) => a + b, 0);
  let run = 0;
  for (const [i, length] of lengths.entries()) {
    const [x0, y0] = points[i];
    const [x1, y1] = points[i + 1];
    for (let d = 0; d < length; d += pitch * 1.25)
      out.push([x0 + ((x1 - x0) * d) / length, y0 + ((y1 - y0) * d) / length, (run + d) / total]);
    run += length;
  }
  return out;
};

const pointOn = (points, f) => {
  const lengths = points.slice(1).map((p, i) => Math.hypot(p[0] - points[i][0], p[1] - points[i][1]));
  let target = lengths.reduce((a, b) => a + b, 0) * f;
  for (const [i, length] of lengths.entries()) {
    if (target <= length || i === lengths.length - 1) {
      const k = length ? Math.min(target / length, 1) : 0;
      return [
        points[i][0] + (points[i + 1][0] - points[i][0]) * k,
        points[i][1] + (points[i + 1][1] - points[i][1]) * k,
      ];
    }
    target -= length;
  }
  return points.at(-1);
};

/** cubic-bezier(x1, y1, x2, y2) as a function of progress, solved for x by Newton's method then bisection. */
function bezier(x1, y1, x2, y2) {
  return (x) => {
    if (x <= 0 || x >= 1) return Math.min(Math.max(x, 0), 1);
    let t = x;
    for (let i = 0; i < 6; i++) {
      const d = bezierSlope(x1, x2, t);
      if (Math.abs(d) < 1e-6) break;
      t -= (bezierAt(x1, x2, t) - x) / d;
    }
    t = Math.min(Math.max(t, 0), 1);
    return bezierAt(y1, y2, t);
  };
}

// The motion-design house curves: the reverb for arrivals, Material standard for state changes.
const EASE_ENTER = bezier(0.1, 1, 0.1, 1);
const EASE_STATE = bezier(0.2, 0, 0, 1);
const EASE_MOVE = bezier(0.4, 0, 0, 1);

/** A value that eases from where it is toward a target over a duration. */
class Tween {
  constructor(value) {
    this.from = value;
    this.to = value;
    this.start = 0;
    this.dur = 1;
    this.ease = EASE_STATE;
  }
  set(to, now, dur, ease = EASE_STATE) {
    if (to === this.to) return;
    this.from = this.value(now);
    this.to = to;
    this.start = now;
    this.dur = dur;
    this.ease = ease;
  }
  jump(to) {
    this.from = to;
    this.to = to;
  }
  value(now) {
    const p = Math.min(Math.max((now - this.start) / this.dur, 0), 1);
    return this.from + (this.to - this.from) * this.ease(p);
  }
}

const FLEET_MACHINES = [
  { id: "laptop", label: "laptop" },
  { id: "mini", label: "mac mini" },
  { id: "cloud", label: "cloud-box" },
  { id: "phone", label: "phone" },
  { id: "pi", label: "pi" },
];

/** Each scene's targets per machine: shown, load (0-1), status line; and whether records flow. */
const FLEET_SCENES = [
  {
    laptop: [1, 0.1, "idle"],
    mini: [1, 0.15, "idle"],
    cloud: [1, 0.1, "idle"],
    phone: [1, 0, "paired"],
    pi: [0, 0, ""],
  },
  {
    laptop: [1, 0.35, "working"],
    mini: [1, 0.85, "OmO working"],
    cloud: [1, 0.55, "working"],
    phone: [1, 0.2, "attached"],
    pi: [0, 0, ""],
    flow: true,
  },
  {
    laptop: [1, 0.35, "working"],
    mini: [1, 0.85, "OmO working"],
    cloud: [1, 0.55, "working"],
    phone: [1, 0.2, "attached"],
    pi: [1, 0.15, "joined"],
    flow: true,
    join: true,
  },
  {
    laptop: [1, 0.35, "working"],
    mini: [1, 0.85, "OmO working"],
    cloud: [1, 0, "revoked"],
    phone: [1, 0.2, "attached"],
    pi: [1, 0.4, "working"],
    flow: true,
    revoke: "cloud",
  },
];

/** Packet routes for the work scenes: phone and mac mini answer each other, the rest is background traffic. */
const FLEET_ROUTES = [
  ["phone", "mini"],
  ["mini", "phone"],
  ["laptop", "cloud"],
  ["mini", "laptop"],
  ["pi", "mini"],
];

/**
 * The fleet: a dot-matrix view of the relay and the machines linked through it, in four scenes (link up, work,
 * join, revoke). Drawn on one canvas while on screen; under reduced motion each scene is drawn settled, with two
 * sealed records parked on their links instead of moving ones.
 */
function setupFleet() {
  const root = document.querySelector("[data-fleet]");
  const canvas = root.querySelector("canvas");
  const ctx = canvas.getContext("2d");
  const buttons = [...root.querySelectorAll("[data-fleet-step]")];
  const texts = [...root.querySelectorAll("[data-fleet-text]")];
  const machines = new Map(
    FLEET_MACHINES.map((m) => [m.id, { ...m, shown: new Tween(0), load: new Tween(0), cut: new Tween(0), status: "" }]),
  );
  let scene = 0;
  let packets = [];
  // Signed membership records (admit, revoke) fan out from the laptop through the relay to every member.
  let records = [];
  let timeline = [];
  let colors = {};
  let geo;
  let raf = 0;
  let timer = 0;
  let nextPacket = 0;
  let visible = false;

  const readColors = () => {
    const style = getComputedStyle(document.documentElement);
    const v = (name) => style.getPropertyValue(name).trim();
    colors = {
      ink: v("--ink"),
      ink2: v("--ink-2"),
      ink3: v("--ink-3"),
      dot: v("--dot"),
      line: v("--line-strong"),
      accent: v("--accent"),
      cipher: v("--cipher"),
      ok: v("--ok"),
      danger: v("--danger"),
      surface: v("--surface"),
    };
  };

  const layout = () => {
    const width = canvas.clientWidth;
    const narrow = width < 640;
    const height = narrow ? 300 : 380;
    const dpr = Math.min(devicePixelRatio || 1, 2);
    canvas.style.height = height + "px";
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const pitch = narrow ? 5 : 8;
    const count = FLEET_MACHINES.length;
    const gap = narrow ? 8 : 28;
    const boxW = Math.floor((width - gap * (count - 1) - (narrow ? 0 : 40)) / count / pitch) * pitch;
    const boxH = (narrow ? 10 : 12) * pitch;
    const rowW = boxW * count + gap * (count - 1);
    const left = Math.round((width - rowW) / 2);
    const boxTop = height - boxH - (narrow ? 44 : 52);
    const hub = { x: Math.round(width / 2), y: narrow ? 44 : 56 };
    const boxes = new Map(
      FLEET_MACHINES.map((m, i) => [m.id, { x: left + i * (boxW + gap), y: boxTop, w: boxW, h: boxH }]),
    );
    const paths = new Map(
      FLEET_MACHINES.map((m) => {
        const b = boxes.get(m.id);
        const cx = b.x + b.w / 2;
        const bend = hub.y + (boxTop - hub.y) * 0.45;
        return [
          m.id,
          [
            [hub.x, hub.y + pitch * 3],
            [hub.x, bend - 6],
            [cx, boxTop - pitch * 3],
            [cx, boxTop - pitch],
          ],
        ];
      }),
    );
    geo = { width, height, pitch, narrow, hub, boxes, paths };
  };

  const square = (x, y, size, color, alpha = 1) => {
    ctx.globalAlpha = alpha;
    ctx.fillStyle = color;
    ctx.fillRect(Math.round(x - size / 2), Math.round(y - size / 2), size, size);
  };

  const draw = (now) => {
    const { width, height, pitch, narrow, hub, boxes, paths } = geo;
    ctx.clearRect(0, 0, width, height);
    const dot = Math.max(2, Math.round(pitch * 0.42));
    // background field
    for (let y = pitch; y < height; y += pitch * 2)
      for (let x = pitch; x < width; x += pitch * 2) square(x, y, 2, colors.dot, 0.6);
    // links
    for (const m of FLEET_MACHINES) {
      const state = machines.get(m.id);
      const shown = state.shown.value(now);
      if (shown <= 0.001) continue;
      const cut = state.cut.value(now);
      for (const [x, y, f] of dotted(paths.get(m.id), pitch)) {
        if (f > shown) break;
        const broken = cut > 0 && f > 0.45 && f < 0.75;
        square(x, y, dot, broken ? colors.danger : colors.line, broken ? cut : 1 - cut * 0.6);
      }
    }
    // hub
    for (let r = -2; r <= 2; r++)
      for (let c = -2; c <= 2; c++)
        square(
          hub.x + c * pitch,
          hub.y + r * pitch,
          dot + 1,
          colors.cipher,
          Math.abs(r) + Math.abs(c) > 3 ? 0.35 : 0.9,
        );
    ctx.globalAlpha = 1;
    ctx.font = (narrow ? "500 11px" : "500 12px") + ' "Timeless Sans", ui-sans-serif, system-ui, sans-serif';
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillStyle = colors.ink2;
    ctx.fillText("relay \u00b7 ciphertext only", hub.x + pitch * 3.5, hub.y);
    // machines
    ctx.textAlign = "center";
    for (const m of FLEET_MACHINES) {
      const state = machines.get(m.id);
      const shown = state.shown.value(now);
      const box = boxes.get(m.id);
      const lift = (1 - shown) * 10;
      const cols = Math.round(box.w / pitch);
      const rows = Math.round(box.h / pitch);
      const load = state.load.value(now);
      const cut = state.cut.value(now);
      const lit = Math.round(rows * load);
      // A slot no machine has joined yet is a faint dashed outline, so the join has somewhere to land.
      if (shown < 0.999) {
        for (let r = 0; r < rows; r++)
          for (let c = 0; c < cols; c++) {
            const edge = r === 0 || c === 0 || r === rows - 1 || c === cols - 1;
            if (edge && (r + c) % 2 === 0)
              square(box.x + c * pitch + pitch / 2, box.y + r * pitch + pitch / 2, dot, colors.line, (1 - shown) * 0.7);
          }
        ctx.globalAlpha = (1 - shown) * 0.7;
        ctx.fillStyle = colors.ink3;
        ctx.fillText(m.label, box.x + box.w / 2, box.y + box.h + 16);
        ctx.fillText(state.ghost ?? "not joined", box.x + box.w / 2, box.y + box.h + 32);
      }
      for (let r = 0; r < rows; r++)
        for (let c = 0; c < cols; c++) {
          const edge = r === 0 || c === 0 || r === rows - 1 || c === cols - 1;
          const filled = !edge && rows - 1 - r <= lit;
          if (!edge && !filled) continue;
          const color =
            cut > 0.5 ? colors.danger : filled ? (m.id === "mini" ? colors.accent : colors.ink2) : colors.line;
          square(
            box.x + c * pitch + pitch / 2,
            box.y + r * pitch + pitch / 2 + lift,
            dot,
            color,
            shown * (filled ? 0.85 : 1) * (1 - cut * 0.55),
          );
        }
      ctx.globalAlpha = shown;
      ctx.fillStyle = colors.ink;
      ctx.fillText(m.label, box.x + box.w / 2, box.y + box.h + 16 + lift);
      ctx.fillStyle = cut > 0.5 ? colors.danger : colors.ink3;
      ctx.fillText(
        narrow ? state.status.replace("OmO working", "OmO") : state.status,
        box.x + box.w / 2,
        box.y + box.h + 32 + lift,
      );
    }
    // packets: sealed (cipher) on the way, opened (accent) for the last stretch into the machine they are for
    for (const p of packets) {
      const k = Math.min(Math.max((now - p.start) / p.dur, 0), 1);
      const f = p.parked ?? EASE_MOVE(k);
      const up = paths.get(p.from);
      const down = paths.get(p.to);
      const [x, y] = f < 0.5 ? pointOn(up.toReversed(), f * 2) : pointOn(down, (f - 0.5) * 2);
      const opened = f > 0.92;
      for (const [dx, dy] of [
        [0, 0],
        [1, 0],
        [0, 1],
        [1, 1],
      ])
        square(x + (dx - 0.5) * pitch, y + (dy - 0.5) * pitch, dot + 1, opened ? colors.accent : colors.cipher, 1);
    }
    // records: a plus-shaped glyph, green for admit and red for revoke, laptop to relay, then relay to every member
    for (const record of records) {
      const k = Math.min(Math.max((now - record.start) / record.dur, 0), 1);
      if (k <= 0 || k >= 1) continue;
      const color = record.kind === "admit" ? colors.ok : colors.danger;
      const plus = (x, y) => {
        for (const [dx, dy] of [
          [0, -1],
          [-1, 0],
          [0, 0],
          [1, 0],
          [0, 1],
        ])
          square(x + dx * pitch * 0.7, y + dy * pitch * 0.7, dot + 1, color, 1);
      };
      if (k < 0.45) plus(...pointOn(paths.get("laptop").toReversed(), EASE_MOVE(k / 0.45)));
      else
        for (const m of FLEET_MACHINES) {
          if (m.id === "laptop" || (machines.get(m.id).shown.value(now) < 0.5 && m.id !== record.to)) continue;
          plus(...pointOn(paths.get(m.id), EASE_MOVE((k - 0.45) / 0.55)));
        }
    }
    ctx.globalAlpha = 1;
  };

  const apply = (index, now, animate) => {
    scene = index;
    for (const id of timeline) clearTimeout(id);
    timeline = [];
    records = [];
    const targets = FLEET_SCENES[index];
    for (const [i, m] of FLEET_MACHINES.entries()) {
      const [shown, load, status] = targets[m.id];
      const state = machines.get(m.id);
      state.status = status;
      if (animate) {
        state.shown.set(shown, now + i * 50, 900, EASE_ENTER);
        // The machine being revoked keeps working until its revoke record lands (scheduled below).
        if (targets.revoke !== m.id) {
          state.load.set(load, now + 200 + i * 40, 700, EASE_STATE);
          state.cut.set(0, now + 150, 500, EASE_STATE);
        }
      } else {
        state.shown.jump(shown);
        state.load.jump(load);
        state.cut.jump(targets.revoke === m.id ? 1 : 0);
      }
    }
    // Join and revoke happen in order: the signed record crosses the mesh first, then the machine changes.
    const later = (ms, fn) => timeline.push(setTimeout(fn, ms));
    if (animate && targets.join) {
      const pi = machines.get("pi");
      pi.shown.jump(0);
      pi.ghost = "asks to join";
      pi.status = "joined";
      records.push({ kind: "admit", to: "pi", start: now + 500, dur: 1700 });
      later(2200, () => {
        const at = performance.now();
        pi.shown.set(1, at, 900, EASE_ENTER);
        pi.load.set(targets.pi[1], at + 200, 700, EASE_STATE);
      });
    }
    if (animate && targets.revoke) {
      const gone = machines.get(targets.revoke);
      // A restart finds the machine already revoked (load 0): it works again, at the work scene's load, until the record lands.
      gone.cut.jump(0);
      gone.load.jump(FLEET_SCENES[1][targets.revoke][1]);
      gone.status = "working";
      records.push({ kind: "revoke", to: targets.revoke, start: now + 500, dur: 1700 });
      later(2200, () => {
        const at = performance.now();
        gone.status = "revoked";
        gone.cut.set(1, at, 500, EASE_STATE);
        gone.load.set(0, at, 500, EASE_STATE);
      });
    }
    if (!targets.join) machines.get("pi").ghost = "not joined";
    for (const [i, button] of buttons.entries()) button.setAttribute("aria-pressed", String(i === index));
    for (const [i, text] of texts.entries()) text.hidden = i !== index;
    packets = [];
    if (!animate && targets.flow) {
      // the still frame parks two sealed records on their way through the relay
      packets = [
        { from: "phone", to: "mini" },
        { from: "laptop", to: "cloud" },
      ].map((p, i) => Object.assign(p, { parked: i ? 0.3 : 0.7, start: now, dur: Infinity }));
    }
  };

  const routesFor = () => {
    return FLEET_ROUTES.filter(
      // A machine carries traffic once it has joined (its shown target) and until its revoke lands (its cut target).
      ([a, b]) => [a, b].every((id) => machines.get(id).shown.to > 0.5 && machines.get(id).cut.to < 0.5),
    );
  };

  const frame = (now) => {
    if (FLEET_SCENES[scene].flow && now >= nextPacket) {
      const routes = routesFor();
      const [from, to] = routes[Math.floor(Math.random() * routes.length)];
      packets.push({ from, to, start: now, dur: 1700 });
      nextPacket = now + 420;
    }
    packets = packets.filter((p) => now - p.start < p.dur);
    draw(now);
    raf = requestAnimationFrame(frame);
  };

  const advance = () => {
    apply((scene + 1) % FLEET_SCENES.length, performance.now(), true);
    timer = setTimeout(advance, 5600);
  };

  const running = () => visible && !reducedMotion.matches && document.visibilityState === "visible";
  const sync = () => {
    cancelAnimationFrame(raf);
    clearTimeout(timer);
    if (running()) {
      packets = packets.filter((p) => p.parked === undefined);
      raf = requestAnimationFrame(frame);
      timer = setTimeout(advance, 5600);
    } else {
      apply(scene, performance.now(), false);
      draw(performance.now());
    }
  };

  for (const [i, button] of buttons.entries())
    button.addEventListener("click", () => {
      clearTimeout(timer);
      apply(i, performance.now(), running());
      if (running()) timer = setTimeout(advance, 8000);
      else draw(performance.now());
    });

  readColors();
  layout();
  apply(0, performance.now(), false);
  draw(performance.now());
  // Moving the window to a screen with another pixel density re-sizes the canvas backing store.
  const watchDensity = () =>
    matchMedia(`(resolution: ${devicePixelRatio}dppx)`).addEventListener(
      "change",
      () => {
        layout();
        if (!running()) draw(performance.now());
        watchDensity();
      },
      { once: true },
    );
  watchDensity();
  new ResizeObserver(() => {
    layout();
    if (!running()) draw(performance.now());
  }).observe(canvas);
  new MutationObserver(() => {
    readColors();
    if (!running()) draw(performance.now());
  }).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    readColors();
    if (!running()) draw(performance.now());
  });
  void document.fonts.ready.then(() => {
    if (!running()) draw(performance.now());
    return undefined;
  });
  new IntersectionObserver(([entry]) => {
    const wasVisible = visible;
    visible = entry.isIntersecting;
    // Entering the screen replays the current scene's arrival instead of starting mid-way.
    if (visible && !wasVisible && running()) {
      for (const state of machines.values()) state.shown.jump(0);
      apply(scene, performance.now(), true);
    }
    sync();
  }).observe(root);
  reducedMotion.addEventListener("change", sync);
  document.addEventListener("visibilitychange", sync);
}

setupReveal();
setupTheme();
setupFleet();
setupLive();
setupWire();
setupPipe();
setupPairing();
setupCopy();
