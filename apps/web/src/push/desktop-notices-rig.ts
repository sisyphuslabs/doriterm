import type { EventFeed, HcConnection } from "@doriface/client";
import type { HcEvent, Status, Terminal } from "@doriface/protocol";
import type { ConnectionState } from "../connection/store.ts";
import type { NoticeAnswer, NoticeAuthorization } from "./notice-bridge.ts";

// store.ts builds the app's store from localStorage as it loads; bun has none, so an empty one stands in for that load only.
Object.assign(globalThis, { localStorage: { getItem: () => null, setItem: () => undefined } });
export const { DESKTOP_NOTICES_KEY, DesktopNotices, parseSavedNotices, REFUSAL_REPORT_MS, retryDelay } =
  await import("./desktop-notices.ts");
export const { REPEAT_MS } = await import("./notice-trigger.ts");
Reflect.deleteProperty(globalThis, "localStorage");

/** Drains the microtasks a bridge answer or a failed subscribe takes to reach the view; never a timer. */
export const settled = (): Promise<void> =>
  new Promise((resolve) => {
    let ticks = 20;
    const tick = (): void => {
      ticks -= 1;
      if (ticks === 0) resolve();
      else queueMicrotask(tick);
    };
    queueMicrotask(tick);
  });

export const terminal = (address: string, status: Status | null): Terminal => ({
  address,
  argv: ["agent"],
  cols: 80,
  rows: 24,
  created_ms: 1,
  cwd: "/work",
  labels: {},
  screen: "exact",
  state: "live",
  status,
  status_ms: 1_000,
  turn: 2,
});

let seq = 1;
export const status = (address: string, state: Status, machine?: string): HcEvent => ({
  type: "status",
  seq: seq++,
  terminal: address,
  ...(machine === undefined ? {} : { machine }),
  data: { status: state, records: {}, reported: true },
});

export const done: Status = { state: "done" };

export class FakeFeed {
  readonly #events = new Set<(event: HcEvent) => void>();
  readonly #closes = new Set<() => void>();
  readonly snapshot: { readonly seq: number; readonly terminals: readonly Terminal[] };
  closed = false;
  constructor(snapshot: FakeFeed["snapshot"]) {
    this.snapshot = snapshot;
  }
  onEvent = (listener: (event: HcEvent) => void) => (this.#events.add(listener), () => undefined);
  onSnapshot = () => () => undefined;
  onClose = (listener: () => void) => (this.#closes.add(listener), () => undefined);
  close = (): void => {
    this.closed = true;
    for (const listener of this.#closes) listener();
  };
  emit(event: HcEvent): void {
    for (const listener of this.#events) listener(event);
  }
}

const ACCEPTED: NoticeAnswer = { accepted: true };

/** A DesktopNotices over a fake bridge, feed, clock and scheduler; `failing` subscribes throw before one succeeds. */
export function rig({
  saved = null as string | null,
  supported = true,
  answer = ACCEPTED,
  authorization = "unknown" as NoticeAuthorization,
  terminals = [] as Terminal[],
  failing = 0,
} = {}) {
  const feeds: FakeFeed[] = [];
  let subscribes = 0;
  const live: Pick<HcConnection, "subscribe" | "closed" | "hello"> = {
    closed: false,
    // The core `local` stands for, named in a refusal as its hello names it (#1121).
    hello: { core: { id: "core-test", name: "dev-box" } } as unknown as HcConnection["hello"],
    subscribe: async () => {
      subscribes += 1;
      if (subscribes <= failing) throw new Error("the core is busy");
      const feed = new FakeFeed({ seq: 0, terminals });
      feeds.push(feed);
      return feed as unknown as EventFeed;
    },
  };
  const timers: { ms: number; step: () => void; cancelled: boolean; fired: boolean }[] = [];
  const listeners = new Set<() => void>();
  const connection = {
    state: { phase: "open", connection: live as HcConnection, path: "relay", connectMs: 1 } as ConnectionState,
    subscribe: (listener: () => void) => (listeners.add(listener), () => listeners.delete(listener)),
    move(state: ConnectionState) {
      this.state = state;
      for (const listener of listeners) listener();
    },
  };
  const stored = new Map<string, string>(saved === null ? [] : [[DESKTOP_NOTICES_KEY, saved]]);
  const shown: { kind: string; terminal: string | null }[] = [];
  let now = 0;
  const notices = new DesktopNotices({
    bridge: {
      supported: async () => supported,
      permission: async () => authorization,
      show: async (notice) => (answer.accepted && shown.push(notice), answer),
      onClick: () => undefined,
    },
    storage: { getItem: (key) => stored.get(key) ?? null, setItem: (key, value) => void stored.set(key, value) },
    connection,
    now: () => now,
    schedule: (step, ms) => {
      const timer = { ms, step, cancelled: false, fired: false };
      timers.push(timer);
      return () => void (timer.cancelled = true);
    },
  });
  const feed = async (): Promise<FakeFeed> => {
    await Promise.resolve();
    const last = feeds.at(-1);
    if (last === undefined) throw new Error("no feed was opened");
    return last;
  };
  const pending = () => timers.filter((timer) => !timer.cancelled && !timer.fired);
  const fire = async (): Promise<void> => {
    await settled();
    const waiting = pending();
    const timer = waiting[0];
    if (waiting.length !== 1 || timer === undefined) throw new Error(`${waiting.length} timers wait`);
    timer.fired = true;
    timer.step();
    await settled();
  };
  const reopen = () =>
    connection.move({ phase: "open", connection: live as HcConnection, path: "relay", connectMs: 1 });
  return {
    notices,
    feeds,
    feed,
    fire,
    timers,
    pending,
    shown,
    stored,
    connection,
    reopen,
    tick: (ms: number) => void (now += ms),
    subscribes: () => subscribes,
  };
}
