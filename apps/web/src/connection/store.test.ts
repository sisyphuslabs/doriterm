import { afterEach, expect, jest, test } from "bun:test";
import type { HcConnection } from "@doriface/client";
import type { OpenConnection } from "./connect.ts";
import { LoopbackAddressError } from "./loopback-address.ts";
import { type ConnectionSettings, DEFAULT_RELAY_URL, DEFAULT_SETTINGS } from "./settings.ts";

// store.ts builds the app's store from localStorage as it loads; bun has none, so an empty one stands in for that load only.
Object.assign(globalThis, { localStorage: { getItem: () => null, setItem: () => undefined } });
const { ConnectionStore } = await import("./store.ts");
Reflect.deleteProperty(globalThis, "localStorage");

const SETTINGS: ConnectionSettings = { ...DEFAULT_SETTINGS, mode: "loopback", token: "t0k" };
/** Relay mode, which is where a roster means something: rotation is deliberately off for the loopback gateway. */
const RELAY_SETTINGS: ConnectionSettings = {
  ...DEFAULT_SETTINGS,
  mode: "relay",
  hostId: "a",
  hostKey: "ka",
};

afterEach(() => jest.useRealTimers());

/**
 * A stand-in for the one live connection the store holds. A real `HcConnection` always carries the hello the host
 * answered with — the store reads the host's name out of every connection it opens (#496) — so its stand-in does too;
 * `closes` collects the drop listeners the store installs.
 */
function standIn(name = ""): { readonly connection: HcConnection; readonly closes: ((error?: Error) => void)[] } {
  const closes: ((error?: Error) => void)[] = [];
  const connection = {
    hello: { core: { id: "c0re", name } },
    onClose: (listener: (error?: Error) => void) => (closes.push(listener), () => undefined),
    close: () => undefined,
  } as unknown as HcConnection;
  return { connection, closes };
}

test("retryNow makes the waiting attempt at once, and its back-off timer makes no second one", async () => {
  jest.useFakeTimers();
  const { connection } = standIn();
  let attempts = 0;
  const store = new ConnectionStore(SETTINGS, () => {
    attempts += 1;
    return attempts === 1 ? Promise.reject(new Error("refused")) : Promise.resolve({ connection, path: "relay" });
  });
  const reached = (phase: string): Promise<void> =>
    new Promise((resolve) => {
      const off = store.subscribe(() => {
        if (store.state.phase !== phase) return;
        off();
        resolve();
      });
    });

  const failed = reached("failed");
  store.start();
  await failed;
  expect(store.state).toMatchObject({ phase: "failed", retryInMs: 1_000 });

  const open = reached("open");
  store.retryNow();
  await open;
  expect(attempts).toBe(2);

  jest.advanceTimersByTime(10_000);
  expect(attempts).toBe(2);
  expect(store.state).toEqual({ phase: "open", connection, path: "relay" });
  store.stop();
});

test("a local host that did not start holds its cause and cancels the waiting retry, so no link is tried", async () => {
  jest.useFakeTimers();
  let attempts = 0;
  const store = new ConnectionStore(SETTINGS, () => {
    attempts += 1;
    return Promise.reject(new Error("refused"));
  });
  const failed = new Promise<void>((resolve) => {
    const off = store.subscribe(() => {
      if (store.state.phase !== "failed") return;
      off();
      resolve();
    });
  });
  store.start();
  await failed;
  const failure = { code: "hc-binary-missing", message: "not found", details: "raw output" };
  store.hostStartFailed(failure);
  expect(store.state).toEqual({ phase: "host-failed", failure });
  jest.advanceTimersByTime(10_000);
  store.retryNow();
  expect(attempts).toBe(1);
  expect(store.state).toEqual({ phase: "host-failed", failure });
});

test("in a release build the store connects through the production relay whatever relay the new settings name", async () => {
  const tried: string[] = [];
  const store = new ConnectionStore(DEFAULT_SETTINGS, (settings) => {
    tried.push(settings.relayUrl);
    return Promise.reject(new Error("refused"));
  });
  const written: string[] = [];
  Object.assign(globalThis, { localStorage: { setItem: (_key: string, value: string) => written.push(value) } });
  // A pairing link or an old saved link can name another relay; a release build reaches only the production one.
  store.update({ ...DEFAULT_SETTINGS, relayUrl: "wss://relay.custom.invalid", hostId: "h", hostKey: "k" });
  store.stop();
  Reflect.deleteProperty(globalThis, "localStorage");
  expect(tried).toEqual([DEFAULT_RELAY_URL]);
  expect(written.map((value) => JSON.parse(value).relayUrl)).toEqual([DEFAULT_RELAY_URL]);
  expect(store.settings.relayUrl).toBe(DEFAULT_RELAY_URL);
});

test("a loopback address that is not on this computer is refused once and not retried, its reason shown (#462)", async () => {
  jest.useFakeTimers();
  let attempts = 0;
  const refusal = new LoopbackAddressError("The loopback address must be on this computer.");
  const store = new ConnectionStore(SETTINGS, () => {
    attempts += 1;
    return Promise.reject(refusal);
  });
  const failed = new Promise<void>((resolve) => {
    const off = store.subscribe(() => {
      if (store.state.phase !== "failed") return;
      off();
      resolve();
    });
  });
  store.start();
  await failed;
  expect(store.state).toMatchObject({ phase: "failed", error: refusal, retryInMs: null, retryAt: null });
  jest.advanceTimersByTime(60_000);
  expect(attempts).toBe(1);
  store.stop();
});

test("a loopback link that fails asks this computer's host first, and the retry dials where the host is now (#515)", async () => {
  jest.useFakeTimers();
  // The retry saves where the host is now, as the app does.
  const saved: string[] = [];
  Object.assign(globalThis, {
    localStorage: { getItem: () => null, setItem: (_key: string, value: string) => saved.push(value) },
  });
  const { connection, closes } = standIn();
  const dialled: string[] = [];
  const store = new ConnectionStore({ ...SETTINGS, loopbackUrl: "ws://127.0.0.1:1111/v1/hc" }, (settings) => {
    dialled.push(`${settings.loopbackUrl} ${settings.token}`);
    return Promise.resolve({ connection, path: "loopback" });
  });
  const asked: string[] = [];
  store.restartsLocalHost({
    start: () => {
      asked.push("start");
      return Promise.resolve({ url: "ws://127.0.0.1:2222/v1/hc", token: "n3w" });
    },
    failure: () => ({ code: "unknown", message: "", details: "" }),
  });
  const reached = (phase: string): Promise<void> =>
    new Promise((resolve) => {
      const off = store.subscribe(() => {
        if (store.state.phase !== phase) return;
        off();
        resolve();
      });
    });

  const first = reached("open");
  store.start();
  await first;
  expect(asked).toEqual([]);

  const failed = reached("failed");
  closes[0]?.(new Error("connection is closed"));
  await failed;
  const again = reached("open");
  store.retryNow();
  await again;
  expect(asked).toEqual(["start"]);
  expect(dialled).toEqual(["ws://127.0.0.1:1111/v1/hc t0k", "ws://127.0.0.1:2222/v1/hc n3w"]);
  expect(store.settings).toMatchObject({ loopbackUrl: "ws://127.0.0.1:2222/v1/hc", token: "n3w" });
  expect(saved.at(-1)).toContain("2222");
  store.stop();
  Reflect.deleteProperty(globalThis, "localStorage");
});

/** A stub storage that records every saved connection, as a browser's localStorage does across a reload. */
function recordingStorage(): { readonly written: string[]; readonly restore: () => void } {
  const written: string[] = [];
  Object.assign(globalThis, {
    localStorage: {
      getItem: () => null,
      setItem: (_key: string, value: string) => void written.push(value),
    },
  });
  return { written, restore: () => Reflect.deleteProperty(globalThis, "localStorage") };
}

test("the host's name is saved beside the paired host, so a load without it still knows what to call it (#496)", async () => {
  const storage = recordingStorage();
  const { connection } = standIn("studio");
  const store = new ConnectionStore(
    { ...DEFAULT_SETTINGS, hostId: "h0st", hostKey: "k3y" },
    (): Promise<OpenConnection> => Promise.resolve({ connection, path: "relay" }),
  );
  const open = new Promise<void>((resolve) => {
    const off = store.subscribe(() => {
      if (store.state.phase !== "open") return;
      off();
      resolve();
    });
  });
  store.start();
  await open;
  expect(store.settings.hostName).toBe("studio");
  expect(JSON.parse(storage.written.at(-1) ?? "{}")).toMatchObject({ hostId: "h0st", hostName: "studio" });
  store.stop();
  storage.restore();
});

test("a name belongs to the host that said it, so pairing another host does not keep the first one's (#496)", () => {
  const storage = recordingStorage();
  const store = new ConnectionStore({ ...DEFAULT_SETTINGS, hostId: "h0st", hostKey: "k3y", hostName: "studio" }, () =>
    Promise.reject(new Error("refused")),
  );
  store.update({ ...store.settings, hostId: "0ther" });
  expect(store.settings.hostName).toBe("");
  expect(JSON.parse(storage.written.at(-1) ?? "{}")).toMatchObject({ hostId: "0ther", hostName: "" });
  store.stop();
  storage.restore();
});

test("a host that does not start again shows its cause, and no link is tried", async () => {
  jest.useFakeTimers();
  let attempts = 0;
  const store = new ConnectionStore(SETTINGS, () => {
    attempts += 1;
    return Promise.reject(new Error("refused"));
  });
  store.restartsLocalHost({
    start: () => Promise.reject(new Error("no hc")),
    failure: (cause) => ({ code: "unknown", message: String(cause), details: "" }),
  });
  const failed = new Promise<void>((resolve) => {
    const off = store.subscribe(() => {
      if (store.state.phase !== "failed") return;
      off();
      resolve();
    });
  });
  store.start();
  await failed;
  const hostFailed = new Promise<void>((resolve) => {
    const off = store.subscribe(() => {
      if (store.state.phase !== "host-failed") return;
      off();
      resolve();
    });
  });
  store.retryNow();
  await hostFailed;
  expect(attempts).toBe(1);
  expect(store.state).toMatchObject({ phase: "host-failed", failure: { message: "Error: no hc" } });
  store.stop();
});

test("the open state carries the path its session opened on (#446 §5)", async () => {
  jest.useFakeTimers();
  const { connection } = standIn();
  const store = new ConnectionStore({ ...DEFAULT_SETTINGS, hostId: "h", hostKey: "k" }, (): Promise<OpenConnection> =>
    Promise.resolve({ connection, path: "direct" }),
  );
  const opened = new Promise<void>((resolve) => {
    const off = store.subscribe(() => {
      if (store.state.phase !== "open") return;
      off();
      resolve();
    });
  });
  store.start();
  await opened;
  expect(store.state).toMatchObject({ phase: "open", path: "direct" });
  store.stop();
});

test("a direct link that drops sends the next attempt to the relay at once, once (#446 §4)", async () => {
  jest.useFakeTimers();
  const { connection, closes } = standIn();
  const skip: (boolean | undefined)[] = [];
  const store = new ConnectionStore(
    { ...DEFAULT_SETTINGS, hostId: "h", hostKey: "k" },
    (_settings, _signal, _deps, options) => {
      skip.push(options?.skipDirect);
      return Promise.resolve({ connection, path: skip.length === 1 ? "direct" : "relay" });
    },
  );
  const reached = (phase: string): Promise<void> =>
    new Promise((resolve) => {
      const off = store.subscribe(() => {
        if (store.state.phase !== phase) return;
        off();
        resolve();
      });
    });
  const first = reached("open");
  store.start();
  await first;
  const failed = reached("failed");
  closes[0]?.(new Error("the direct link dropped"));
  await failed;
  const again = reached("open");
  store.retryNow();
  await again;
  expect(skip).toEqual([undefined, true]);
  expect(store.state).toMatchObject({ phase: "open", path: "relay" });
  store.stop();
});

const untilAttempt = (store: InstanceType<typeof ConnectionStore>, attempt: number): Promise<void> =>
  new Promise((resolve) => {
    const off = store.subscribe(() => {
      const state = store.state;
      if (state.phase !== "connecting" || state.attempt < attempt) return;
      off();
      resolve();
    });
  });

const untilPhase = (store: InstanceType<typeof ConnectionStore>, phase: string): Promise<void> =>
  new Promise((resolve) => {
    if (store.state.phase === phase) return resolve();
    const off = store.subscribe(() => {
      if (store.state.phase !== phase) return;
      off();
      resolve();
    });
  });

const TWO_MEMBERS = [
  { hostId: "a", hostName: "studio", hostKey: "ka", directUrl: "" },
  { hostId: "b", hostName: "laptop", hostKey: "kb", directUrl: "" },
] as const;

test("one host stopping moves the attempt to the next member of the roster (#942)", async () => {
  const asked: string[] = [];
  const store = new ConnectionStore({ ...RELAY_SETTINGS, hostId: "a", hostKey: "ka", members: TWO_MEMBERS }, ((
    settings: ConnectionSettings,
  ) => {
    asked.push(settings.hostId);
    throw new Error("no answer");
  }) as never);
  store.start();
  await untilPhase(store, "failed");
  expect(asked).toEqual(["a"]);
  const second = untilAttempt(store, 1);
  await second;
  store.stop();
  expect(asked).toContain("b");
});

test("a single member is never rotated away from, so one host behaves as it always did", async () => {
  const asked: string[] = [];
  const store = new ConnectionStore(
    {
      ...RELAY_SETTINGS,
      hostId: "only",
      hostKey: "ko",
      members: [{ hostId: "only", hostName: "studio", hostKey: "ko", directUrl: "" }],
    },
    ((settings: ConnectionSettings) => {
      asked.push(settings.hostId);
      throw new Error("no answer");
    }) as never,
  );
  store.start();
  await untilPhase(store, "failed");
  store.retryNow();
  await untilAttempt(store, 1);
  store.stop();
  expect(new Set(asked)).toEqual(new Set(["only"]));
});

test("a selected host missing from its own roster is never replaced by the first member", async () => {
  const asked: string[] = [];
  const store = new ConnectionStore({ ...RELAY_SETTINGS, hostId: "gone", hostKey: "kg", members: TWO_MEMBERS }, ((
    settings: ConnectionSettings,
  ) => {
    asked.push(settings.hostId);
    throw new Error("no answer");
  }) as never);
  store.start();
  await untilPhase(store, "failed");
  store.retryNow();
  await untilAttempt(store, 1);
  store.stop();
  expect(new Set(asked)).toEqual(new Set(["gone"]));
});

test("loopback never rotates: the address is this computer's own gateway, not a member", async () => {
  const asked: string[] = [];
  const store = new ConnectionStore({ ...SETTINGS, hostId: "a", members: TWO_MEMBERS }, ((
    settings: ConnectionSettings,
  ) => {
    asked.push(settings.hostId);
    throw new Error("no answer");
  }) as never);
  store.start();
  await untilPhase(store, "failed");
  store.retryNow();
  await untilAttempt(store, 1);
  store.stop();
  expect(new Set(asked)).toEqual(new Set(["a"]));
});

test("a live link that drops moves the next attempt to another member (#942)", async () => {
  const asked: string[] = [];
  const live = standIn("studio");
  const store = new ConnectionStore({ ...RELAY_SETTINGS, hostId: "a", hostKey: "ka", members: TWO_MEMBERS }, ((
    settings: ConnectionSettings,
  ) => {
    asked.push(settings.hostId);
    if (asked.length === 1) return Promise.resolve({ connection: live.connection, path: "relay" } as OpenConnection);
    throw new Error("no answer");
  }) as never);
  store.start();
  await untilPhase(store, "open");
  // The host stops answering: the live link drops, which arrives through onClose rather than through a failed attempt.
  for (const close of live.closes) close();
  await untilPhase(store, "failed");
  const second = untilAttempt(store, 1);
  await second;
  store.stop();
  expect(asked).toContain("b");
});

test("pairing with another host puts it in the in-memory roster at once, not only in the file (#994 review)", () => {
  const store = new ConnectionStore(SETTINGS, (async () => {
    throw new Error("not dialed in this test");
  }) as never);
  store.update({
    ...SETTINGS,
    hostId: "new",
    hostName: "laptop",
    hostKey: "kn",
    members: [{ hostId: "old", hostName: "studio", hostKey: "ko", directUrl: "" }],
  });
  expect(store.settings.members.map((member) => member.hostId)).toEqual(["new"]);
  store.stop();
});

test("a freshly paired host survives its first failure; the app does not fall back to the one before it (#994 HIGH)", async () => {
  const asked: string[] = [];
  const store = new ConnectionStore({ ...RELAY_SETTINGS, hostId: "a", hostKey: "ka", members: TWO_MEMBERS }, ((
    settings: ConnectionSettings,
  ) => {
    asked.push(settings.hostId);
    throw new Error("no answer");
  }) as never);
  // The reviewer's scene: pair with c while the roster still names a and b.
  store.update({
    ...RELAY_SETTINGS,
    hostId: "c",
    hostName: "studio-c",
    hostKey: "kc",
    members: TWO_MEMBERS,
  } as ConnectionSettings);
  const failed = untilPhase(store, "failed");
  store.start();
  await failed;
  store.stop();
  expect(store.settings.hostId).toBe("c");
  expect(store.settings.members.map((member) => member.hostId)).toEqual(["c"]);
  expect(asked).not.toContain("a");
});
