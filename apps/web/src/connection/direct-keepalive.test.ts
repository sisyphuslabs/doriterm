import { DIRECT_IDLE_MS, startHost, type Host } from "@doriface/host";
import { createHcSession, type HcSession } from "@doriface/host/testing";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DIRECT_PING_MS, openDirectLink } from "./direct-attempt.ts";
import { fakeWebSockets } from "./fake-websocket.test-support.ts";

const IDLE_MS = 300;
/** Chromium runs a hidden page's timers about once a minute, however short the timer asked for. */
const HIDDEN_THROTTLE_MS = 60_000;
const stateDir = mkdtempSync(join(tmpdir(), "dw-direct-keepalive-"));
let hc: HcSession;
let host: Host;

beforeAll(async () => {
  hc = createHcSession("doriface-web-direct-keepalive");
  host = await startHost({
    listen: { hostname: "127.0.0.1", port: 0 },
    token: "web-direct-keepalive-token-web-direct-keepalive",
    hc: hc.hc,
    session: hc.name,
    env: hc.env,
    stateDir,
    directIdleMs: IDLE_MS,
    log: () => {},
  });
});

afterAll(async () => {
  await host.stop();
  await hc.dispose();
  rmSync(stateDir, { recursive: true, force: true });
});

function e2eeUrl(): string {
  const url = host.e2ee?.url;
  if (url === undefined) throw new Error("no e2ee endpoint");
  return url;
}

/** A socket that never sends anything: the host closes it once its idle deadline passes, which marks that moment. */
function silentSocket(): Promise<number> {
  const socket = new WebSocket(e2eeUrl());
  return new Promise((resolve) => socket.addEventListener("close", (event) => resolve(event.code)));
}

test("an idle direct link keeps its socket past the host's idle deadline (#1040)", async () => {
  const link = await openDirectLink(e2eeUrl(), undefined, IDLE_MS / 6);
  const linkClosed = new Promise<string>((resolve) =>
    link.onClose((error) => resolve(`link closed: ${String(error)}`)),
  );
  // Opened after the link, so its deadline passes after the link's would have.
  const silent = silentSocket().then((code) => `silent socket closed with ${code}`);
  expect(await Promise.race([linkClosed, silent])).toBe("silent socket closed with 4408");
  link.close();
});

test("the direct link pings well inside the host's idle deadline", () => {
  expect(DIRECT_PING_MS * 3).toBeLessThanOrEqual(DIRECT_IDLE_MS);
});

/**
 * A hidden page's timers and the host's idle close, on one clock the test moves: an interval runs at most once a minute,
 * and the host is idle when DIRECT_IDLE_MS passes with nothing received.
 */
function hiddenTab() {
  const realSetInterval = globalThis.setInterval;
  const realClearInterval = globalThis.clearInterval;
  const timers = new Map<number, { readonly fn: () => void; readonly every: number; last: number }>();
  let nextId = 1;
  let now = 0;
  let trafficAt = 0;
  let idle = false;
  const deadline = (): number => trafficAt + DIRECT_IDLE_MS;
  globalThis.setInterval = ((fn: () => void, every: number) => {
    const id = nextId++;
    timers.set(id, { fn, every, last: now });
    return id as unknown as ReturnType<typeof setInterval>;
  }) as typeof setInterval;
  globalThis.clearInterval = ((timer: ReturnType<typeof setInterval>) => {
    timers.delete(timer as unknown as number);
  }) as typeof clearInterval;
  return {
    get idle(): boolean {
      return idle;
    },
    /** The host received bytes now: its idle deadline starts again. */
    heard(): void {
      trafficAt = now;
    },
    /** Moves to `target`, running each clamped interval; stopping at the deadline the host would have closed on. */
    runUntil(target: number): void {
      while (!idle && now < target) {
        const due = [...timers.entries()]
          .map(([id, timer]) => ({ id, at: timer.last + Math.max(timer.every, HIDDEN_THROTTLE_MS) }))
          .toSorted((a, b) => a.at - b.at)[0];
        now = Math.min(due?.at ?? Number.POSITIVE_INFINITY, deadline(), target);
        if (now >= deadline()) {
          idle = true;
          return;
        }
        if (due === undefined || due.at !== now) continue;
        const timer = timers.get(due.id);
        if (timer === undefined) continue;
        timer.last = now;
        timer.fn();
      }
    },
    restore(): void {
      globalThis.setInterval = realSetInterval;
      globalThis.clearInterval = realClearInterval;
    },
  };
}

test("a hidden tab's minute-clamped timers still ping inside the host's idle deadline (#1115)", async () => {
  const tab = hiddenTab();
  const sockets = fakeWebSockets();
  try {
    const opening = openDirectLink("ws://127.0.0.1:7767/v1/e2ee", undefined, DIRECT_PING_MS);
    const socket = sockets.created[0];
    if (socket === undefined) throw new Error("the direct link opened no socket");
    socket.onSend = () => tab.heard();
    tab.heard();
    socket.open();
    await opening;

    for (let minute = 1; minute <= 5; minute += 1) {
      tab.runUntil(minute * HIDDEN_THROTTLE_MS);
      expect(tab.idle).toBe(false);
    }
    // Clamped to one run a minute: five pings in five hidden minutes, not ten.
    expect(socket.sent).toEqual(["ping", "ping", "ping", "ping", "ping"]);
  } finally {
    tab.restore();
    sockets.restore();
  }
});
