const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
const SVG_NS = "http://www.w3.org/2000/svg";
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

const edgeKey = (a, b) => [a, b].toSorted().join("|");

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
  // The mockups carry React and the app's stylesheet: start loading one only when it comes within a screen of view.
  const load = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const frame = entry.target.querySelector("iframe");
        frame.src = frame.dataset.src;
        load.unobserve(entry.target);
      }
    },
    { rootMargin: "50% 0px" },
  );
  for (const box of document.querySelectorAll(".live")) {
    resize.observe(box);
    load.observe(box);
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

const SERVER_ICON = "M-11 -10h22v8h-22zM-11 2h22v8h-22zM-7 -6h.01M-7 6h.01";
const MESH_HOSTS = [
  { id: "laptop", icon: "M-11 -6h22v13h-22zM-15 10h30" },
  { id: "studio", icon: "M-12 -9h24v15h-24zM-5 11h10M0 6v5" },
  { id: "build-box", icon: SERVER_ICON },
  { id: "vps", icon: SERVER_ICON },
  { id: "pi", icon: "M-9 -9h18v18h-18zM-4 -4h8v8h-8zM-13 -4h4M-13 4h4M9 -4h4M9 4h4" },
];
/** Host positions per stage shape: a wide stage beside the step list, a tall one on phones so labels stay legible. */
const MESH_LAYOUTS = {
  wide: {
    viewBox: "0 0 720 420",
    at: { laptop: [150, 140], studio: [360, 82], "build-box": [575, 150], vps: [530, 330], pi: [220, 332] },
  },
  tall: {
    viewBox: "0 0 360 440",
    at: { laptop: [80, 90], studio: [270, 70], "build-box": [295, 250], vps: [205, 370], pi: [70, 300] },
  },
};
const narrowStage = matchMedia("(max-width: 640px)");
const MEMBERS = ["laptop", "studio", "build-box", "vps"];

function setupMesh() {
  const root = document.querySelector("[data-mesh]");
  const svg = root.querySelector("svg");
  const edgeLayer = svg.querySelector("[data-edges]");
  const sparkLayer = svg.querySelector("[data-sparks]");
  const hostLayer = svg.querySelector("[data-hosts]");
  const steps = [...root.querySelectorAll("[data-step]")];
  const hosts = new Map();
  const edges = new Map();
  let at = MESH_LAYOUTS.wide.at;
  const pos = (id) => at[id];

  for (let i = 0; i < MESH_HOSTS.length; i++) {
    for (let j = i + 1; j < MESH_HOSTS.length; j++) {
      const path = document.createElementNS(SVG_NS, "path");
      path.setAttribute("class", "edge off");
      edgeLayer.append(path);
      edges.set(edgeKey(MESH_HOSTS[i].id, MESH_HOSTS[j].id), path);
    }
  }

  for (const host of MESH_HOSTS) {
    const group = document.createElementNS(SVG_NS, "g");
    group.setAttribute("class", "host");
    group.innerHTML = `<circle class="ring" r="30"/><path class="icon" d="${host.icon}"/><text y="50">${host.id}</text><text class="tag" y="65"></text>`;
    hostLayer.append(group);
    hosts.set(host.id, group);
  }

  const layout = () => {
    const shape = MESH_LAYOUTS[narrowStage.matches ? "tall" : "wide"];
    at = shape.at;
    svg.setAttribute("viewBox", shape.viewBox);
    root.style.setProperty("--stage-ratio", shape.viewBox.split(" ").slice(2).join(" / "));
    for (const [id, group] of hosts) group.setAttribute("transform", `translate(${pos(id)[0]} ${pos(id)[1]})`);
    for (const [key, path] of edges) {
      const [a, b] = key.split("|").map(pos);
      path.setAttribute("d", `M${a[0]} ${a[1]} L${b[0]} ${b[1]}`);
      path.style.setProperty("--len", String(Math.ceil(path.getTotalLength())));
    }
  };
  layout();
  narrowStage.addEventListener("change", layout);

  const setTag = (id, text) => {
    hosts.get(id).querySelector(".tag").textContent = text;
  };

  const spark = (from, to) => {
    const [ax, ay] = pos(from);
    const [bx, by] = pos(to);
    const dot = document.createElementNS(SVG_NS, "circle");
    dot.setAttribute("class", "spark");
    dot.setAttribute("r", "3.5");
    const motion = document.createElementNS(SVG_NS, "animateMotion");
    motion.setAttribute("dur", "0.9s");
    motion.setAttribute("fill", "freeze");
    motion.setAttribute("begin", "indefinite");
    motion.setAttribute("calcMode", "spline");
    motion.setAttribute("keyTimes", "0;1");
    motion.setAttribute("keyPoints", "0;1");
    motion.setAttribute("keySplines", "0.2 0 0 1");
    motion.setAttribute("path", `M${ax} ${ay} L${bx} ${by}`);
    dot.append(motion);
    sparkLayer.append(dot);
    motion.beginElement();
    setTimeout(() => dot.remove(), 950);
  };

  const highlight = (index) => {
    steps.forEach((step, i) => step.classList.toggle("on", i === index));
  };

  const state = (members, { pending = [], revoked = [] } = {}) => {
    const present = new Set([...members, ...pending, ...revoked]);
    for (const [id, group] of hosts) {
      group.classList.toggle("away", !present.has(id));
      group.classList.toggle("pending", pending.includes(id));
      group.classList.toggle("revoked", revoked.includes(id));
      setTag(id, pending.includes(id) ? "asks to join" : revoked.includes(id) ? "revoked" : "");
    }
    for (const [key, path] of edges) {
      const [a, b] = key.split("|");
      const linked = members.includes(a) && members.includes(b);
      const cut = revoked.includes(a) || revoked.includes(b);
      path.classList.toggle("off", !linked && !cut);
      path.classList.toggle("cut", cut && (members.includes(a) || members.includes(b)));
    }
  };

  const still = () => {
    highlight(-1);
    state([...MEMBERS, "pi"]);
  };

  loopWhileVisible(
    root,
    async (signal) => {
      highlight(0);
      state(MEMBERS);
      await sleep(2800, signal);

      highlight(1);
      state(MEMBERS, { pending: ["pi"] });
      spark("pi", "laptop");
      await sleep(2800, signal);

      highlight(2);
      state([...MEMBERS, "pi"]);
      for (const member of MEMBERS) spark("laptop", member === "laptop" ? "pi" : member);
      await sleep(900, signal);
      for (const member of MEMBERS) spark(member, "pi");
      await sleep(2600, signal);

      highlight(3);
      state(["laptop", "studio", "build-box", "pi"], { revoked: ["vps"] });
      await sleep(3200, signal);
      state(["laptop", "studio", "build-box", "pi"]);
      await sleep(900, signal);
    },
    still,
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

/** A workflow node's end state: completed, or blocked for the one node that waits on its GPU quota. */
const finish = (node) => (node.dataset.state = node.dataset.kind === "blocked" ? "blocked" : "done");

/**
 * The hero's OmO window: OmO boots on the mac mini tab, takes a mass ulw prompt, and runs its demo workflow wave by
 * wave. Each node goes pending, running, completed (model-train stays blocked on its GPU quota). Opacity only.
 */
function setupOmoWindow() {
  const root = document.querySelector("[data-omowin]");
  const waves = [...root.querySelectorAll("[data-wave]")];
  const nodes = [...root.querySelectorAll("[data-node]")];
  const progress = root.querySelector("[data-progress]");
  const setStep = (step) => (root.dataset.step = String(step));
  const count = () => {
    let total = 0;
    for (const wave of waves) {
      const done = wave.querySelectorAll('[data-state="done"]').length;
      wave.querySelector("[data-done]").textContent = String(done);
      total += done;
    }
    progress.textContent = String(total);
  };
  const reset = () => {
    setStep(3);
    for (const node of nodes) {
      if (node.dataset.kind === "last") node.dataset.state = "running";
      else finish(node);
    }
    count();
  };
  loopWhileVisible(
    root,
    async (signal) => {
      setStep(0);
      for (const node of nodes) node.dataset.state = "pending";
      count();
      await sleep(500, signal);
      setStep(1);
      await sleep(700, signal);
      setStep(2);
      await sleep(900, signal);
      setStep(3);
      await sleep(600, signal);
      // A wave's nodes start a beat apart and finish in a different order, as parallel agents do.
      const runWave = (wave) => {
        const members = [...wave.querySelectorAll("[data-node]")];
        const start = members.map((node, i) => () => {
          node.dataset.state = "running";
          return sleep(i < members.length - 1 ? 140 : 0, signal);
        });
        if (members.every((node) => node.dataset.kind === "last")) return sequence(start);
        const end = members.toReversed().map((node) => () => {
          finish(node);
          count();
          return sleep(220, signal);
        });
        return sequence([...start, () => sleep(1100, signal), ...end, () => sleep(260, signal)]);
      };
      await sequence(waves.map((wave) => () => runWave(wave)));
      await sleep(3200, signal);
    },
    reset,
  );
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
    phone: [1, 0, "client"],
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
        ctx.fillText("not joined", box.x + box.w / 2, box.y + box.h + 32);
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
      const f = EASE_MOVE(k);
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
    ctx.globalAlpha = 1;
  };

  const apply = (index, now, animate) => {
    scene = index;
    const targets = FLEET_SCENES[index];
    for (const [i, m] of FLEET_MACHINES.entries()) {
      const [shown, load, status] = targets[m.id];
      const state = machines.get(m.id);
      state.status = status;
      if (animate) {
        state.shown.set(shown, now + i * 50, 900, EASE_ENTER);
        state.load.set(load, now + 200 + i * 40, 700, EASE_STATE);
        state.cut.set(targets.revoke === m.id ? 1 : 0, now + 150, 500, EASE_STATE);
      } else {
        state.shown.jump(shown);
        state.load.jump(load);
        state.cut.jump(targets.revoke === m.id ? 1 : 0);
      }
    }
    for (const [i, button] of buttons.entries()) button.setAttribute("aria-pressed", String(i === index));
    for (const [i, text] of texts.entries()) text.hidden = i !== index;
    packets = [];
    if (!animate && targets.flow) {
      // the still frame parks two sealed records on their way through the relay
      packets = [
        { from: "phone", to: "mini", start: -1, dur: 1 },
        { from: "laptop", to: "cloud", start: -1, dur: 1 },
      ].map((p, i) => Object.assign(p, { start: now - (i ? 0.3 : 0.7) * 1400, dur: 1400 * 1e9 }));
    }
  };

  const routesFor = () => {
    const targets = FLEET_SCENES[scene];
    return FLEET_ROUTES.filter(
      ([a, b]) => targets[a][0] && targets[b][0] && targets.revoke !== a && targets.revoke !== b,
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
setupOmoWindow();
setupLive();
setupWire();
setupPipe();
setupPairing();
setupMesh();
setupCopy();
