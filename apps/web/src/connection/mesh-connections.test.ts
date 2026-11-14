import { afterEach, describe, expect, it } from "bun:test";
import type { HcConnection } from "@doriface/client";
import type { OpenConnection } from "./connect.ts";
import { MeshConnections, type MemberConnection, type StoreFactory } from "./mesh-connections.ts";
import {
  DEFAULT_SETTINGS,
  loadSettings,
  saveSettings,
  type ConnectionSettings,
  type MemberTarget,
} from "./settings.ts";

const member = (hostId: string, hostName = hostId): MemberTarget => ({
  hostId,
  hostName,
  hostKey: `key-${hostId}`,
  directUrl: "",
});

const settingsWith = (members: readonly MemberTarget[], hostId = members[0]?.hostId ?? ""): ConnectionSettings => ({
  ...DEFAULT_SETTINGS,
  hostId,
  hostName: members.find((entry) => entry.hostId === hostId)?.hostName ?? "",
  hostKey: members.find((entry) => entry.hostId === hostId)?.hostKey ?? "",
  members,
});

/** A connection that opens on start and can be made to fail on its own, standing in for one member's store. */
class FakeConnection implements MemberConnection {
  #state: MemberConnection["state"] = { phase: "unconfigured" };
  readonly #listeners = new Set<() => void>();
  readonly #save: (settings: ConnectionSettings) => void;
  settings: ConnectionSettings;
  started = 0;
  stopped = 0;
  retries = 0;
  adopted: OpenConnection[] = [];

  connecting(): void {
    this.#state = { phase: "connecting", attempt: 1, stale: null };
    this.#emit();
  }

  constructor(settings: ConnectionSettings, save: (settings: ConnectionSettings) => void) {
    this.settings = settings;
    this.#save = save;
  }

  get state(): MemberConnection["state"] {
    return this.#state;
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  start(): void {
    this.started += 1;
    this.#state = { phase: "open", connection: undefined as never, path: "relay" };
    this.#emit();
  }

  adopt(opened: OpenConnection, settings?: ConnectionSettings): void {
    if (settings !== undefined) this.settings = settings;
    this.adopted.push(opened);
    this.#state = { phase: "open", connection: opened.connection, path: opened.path };
    // As the real store does: the session's hello names the host, learned as it opens.
    this.rename(opened.connection.hello.core.name);
    this.#emit();
  }

  stop(): void {
    this.stopped += 1;
    this.#state = { phase: "unconfigured" };
    this.#emit();
  }

  retryNow(): void {
    this.retries += 1;
  }

  updates = 0;

  update(settings: ConnectionSettings): void {
    this.updates += 1;
    this.settings = settings;
  }

  restoring(): void {
    this.stop();
    this.#state = { phase: "connecting", attempt: 0, stale: null };
    this.#emit();
  }

  starters = 0;

  restartsLocalHost(): void {
    this.starters += 1;
  }

  hostStartFailed(): void {}

  /** `retryInMs` null is a failure no retry can help. */
  fail(retryInMs: number | null = 1_000): void {
    this.#state = { phase: "failed", error: new Error(`down`), retryInMs, retryAt: 0, stale: null };
    this.rename(`renamed`);
    this.#emit();
  }

  rename(name: string): void {
    this.settings = { ...this.settings, hostName: name };
    this.#save(this.settings);
  }

  #emit(): void {
    for (const listener of this.#listeners) listener();
  }
}

const harness = (initial: ConnectionSettings, holdsPlace = (): boolean => false) => {
  const made: FakeConnection[] = [];
  const saved: ConnectionSettings[] = [];
  const savers: ((settings: ConnectionSettings) => void)[] = [];
  const factory: StoreFactory = (settings, save) => {
    savers.push(save);
    const connection = new FakeConnection(settings, (next) => {
      saved.push(next);
      save(next);
    });
    made.push(connection);
    return connection;
  };
  return { mesh: new MeshConnections(initial, factory, holdsPlace), made, saved, savers };
};

/** A mesh that is dialling, which is what the boot path does once the settings are known. */
const running = (initial: ConnectionSettings) => {
  const harnessed = harness(initial);
  harnessed.mesh.start();
  return harnessed;
};

afterEach(() => {
  globalThis.localStorage?.clear?.();
  if (!("clear" in (globalThis.localStorage ?? { clear: 0 }))) Reflect.deleteProperty(globalThis, "localStorage");
});

/** A memory localStorage holding `saved`: bun has none, so without it every save is dropped and "not saved" proves nothing. */
function storing(saved: ConnectionSettings): void {
  const kept = new Map<string, string>();
  const storage = {
    getItem: (key: string) => kept.get(key) ?? null,
    setItem: (key: string, value: string) => void kept.set(key, value),
    removeItem: (key: string) => void kept.delete(key),
  };
  Object.assign(globalThis, { localStorage: storage });
  saveSettings(saved);
}

describe("verified view members", () => {
  it("dials learned members independently without saving them as pairings", () => {
    const { mesh, made } = running(settingsWith([member("a")]));
    mesh.setViewMembers([member("a", "view alpha"), member("b", "beta")]);
    expect(made).toHaveLength(2);
    expect(made[1]?.settings).toMatchObject({ hostId: "b", directUrl: "", viewMember: true });
    expect(made[1]?.started).toBe(1);
    mesh.select("b");
    expect(mesh.settings.hostId).toBe("b");
    const snapshot = mesh.settings;
    expect(mesh.settings).toBe(snapshot);
    expect(loadSettings().members.map((m) => m.hostId)).not.toContain("b");
    mesh.setViewMembers([]);
    expect(mesh.entries().map((entry) => entry.target.hostId)).toEqual(["a"]);
    expect(made[1]?.stopped).toBe(1);
  });

  it("a paired key wins over another key in the view for the same host", () => {
    const paired = { ...member("a"), directUrl: "https://paired.invalid" };
    const { mesh, made } = running({ ...settingsWith([paired]), directUrl: paired.directUrl });
    mesh.setViewMembers([{ ...member("a"), hostKey: "view-key" }]);
    expect(mesh.entries()[0]?.target).toEqual(paired);
    expect(made[0]?.settings.hostKey).toBe(paired.hostKey);
    expect(made[0]?.updates).toBe(0);
  });

  it("a stopped member keeps its last-seen time without changing another member", () => {
    const { mesh, made } = running(settingsWith([member("a"), member("b")]));
    const before = mesh.entries()[0]?.lastSeen;
    made[0]?.fail();
    expect(before).toBeNumber();
    expect(mesh.entries()[0]?.lastSeen).toBe(before);
    expect(mesh.entries()[1]?.state.phase).toBe("open");
  });
});

/** A session pairing proved, standing in for the open HcConnection: its hello's name and close are all that is read. */
function provedSession(name = "Build Box"): { readonly opened: OpenConnection; readonly closed: () => number } {
  let closes = 0;
  const connection = {
    hello: { core: { id: "core", name } },
    close: () => {
      closes += 1;
    },
  } as unknown as HcConnection;
  return { opened: { connection, path: "relay" }, closed: () => closes };
}

describe("pairing hands its session on (#1271)", () => {
  it("the paired machine's connection runs on the session pairing proved, and dials nothing", () => {
    const { mesh, made } = running(settingsWith([member("a")], "a"));
    const { opened, closed } = provedSession();
    mesh.pair(settingsWith([member("b")], "b"), opened);
    const paired = made.find((connection) => connection.settings.hostId === "b");
    expect(paired?.adopted).toEqual([opened]);
    expect(paired?.started).toBe(0);
    expect(mesh.state.phase).toBe("open");
    expect(closed()).toBe(0);
  });

  it("the paired machine keeps the name its proved session answered with", () => {
    const { mesh } = running(settingsWith([member("a")], "a"));
    mesh.pair(settingsWith([member("b")], "b"), provedSession("Build Box").opened);
    expect(mesh.settings.hostName).toBe("Build Box");
    expect(mesh.settings.members.find((entry) => entry.hostId === "b")?.hostName).toBe("Build Box");
  });

  it("re-pairing a machine the app already holds hands it the session without telling it to dial first", () => {
    const { mesh, made } = running(settingsWith([member("b", "B")], "b"));
    const held = made.find((connection) => connection.settings.hostId === "b");
    const { opened } = provedSession("B");
    mesh.pair(settingsWith([member("b", "B")], "b"), opened);
    expect([held?.started, held?.updates, held?.adopted]).toEqual([1, 0, [opened]]);
  });
});

describe("one connection per member", () => {
  it("starts a failed member again when asked, which is what the first-connect Try now button calls", () => {
    const { mesh, made } = running(settingsWith([member("a")], "a"));
    expect(made[0]?.started).toBe(1);
    made[0]?.fail();
    mesh.start();
    expect(made[0]?.started).toBe(2);
  });

  it("a second start leaves an open member and a connecting one alone (#1005)", () => {
    const { mesh, made } = running(settingsWith([member("a"), member("b"), member("c")], "a"));
    const [failed, open, connecting] = made;
    failed?.fail();
    connecting?.connecting();
    mesh.start();
    expect(failed?.started).toBe(2);
    expect([open?.started, open?.stopped, open?.state.phase]).toEqual([1, 0, "open"]);
    expect([connecting?.started, connecting?.stopped, connecting?.state.phase]).toEqual([1, 0, "connecting"]);
  });

  it("dials again after restoring stops it, even when the endpoint did not change", () => {
    const { mesh, made } = running(settingsWith([member("a")], "a"));
    expect(made[0]?.started).toBe(1);
    mesh.restoring();
    expect(made[0]?.stopped).toBe(1);
    mesh.update(settingsWith([member("a")], "a"));
    expect(made[0]?.started).toBe(2);
  });

  it("restoring re-dials only the member it stopped, leaving the others' open connections alone (#1140)", () => {
    const roster = settingsWith([member("a"), member("b"), member("c")], "a");
    const { mesh, made } = running(roster);
    const [restored, open, other] = made;
    mesh.restoring();
    mesh.update(roster);
    expect([restored?.stopped, restored?.started]).toEqual([1, 2]);
    expect([open?.started, open?.stopped, open?.state.phase]).toEqual([1, 0, "open"]);
    expect([other?.started, other?.stopped, other?.state.phase]).toEqual([1, 0, "open"]);
  });

  it("tells listeners the selection moved when a machine not reached yet fails over", () => {
    const { mesh, made } = harness(settingsWith([member("a"), member("b")], "a"));
    made[1]?.start();
    let told = 0;
    mesh.subscribe(() => {
      told += 1;
    });
    made[0]?.fail();
    expect(told).toBeGreaterThan(0);
    expect(mesh.settings.hostId).toBe("b");
  });

  it("dials nothing until it is started, so the boot path decides when and against which port", () => {
    const { mesh, made } = harness(settingsWith([member("a"), member("b")]));
    expect(made).toHaveLength(2);
    expect(made.every((connection) => connection.started === 0)).toBe(true);
    mesh.start();
    expect(made.every((connection) => connection.started === 1)).toBe(true);
  });

  it("dials every member of the roster, not only the selected one", () => {
    const { mesh, made } = running(settingsWith([member("a"), member("b"), member("c")]));
    expect(made).toHaveLength(3);
    expect(made.map((connection) => connection.settings.hostId)).toEqual(["a", "b", "c"]);
    expect(made.every((connection) => connection.started === 1)).toBe(true);
    expect(mesh.entries().map((entry) => entry.target.hostId)).toEqual(["a", "b", "c"]);
  });

  it("dials a member learned from the view with no direct address, so only the relay can carry it (#1381 §8)", () => {
    const learned: MemberTarget = { hostId: "b", hostName: "laptop", hostKey: "key-b", directUrl: "" };
    const { made } = running(settingsWith([member("a"), learned], "a"));
    expect(
      made
        .filter((connection) => connection.settings.hostId === "b")
        .map((connection) => connection.settings.directUrl),
    ).toEqual([""]);
  });

  it("keeps the other members open when one host stops", () => {
    const { mesh, made } = running(settingsWith([member("a"), member("b"), member("c")]));
    const [first, second, third] = made;
    first?.fail();
    expect(second?.state.phase).toBe("open");
    expect(third?.state.phase).toBe("open");
    expect(mesh.entries().filter((entry) => entry.state.phase === "open")).toHaveLength(2);
    // The stopped member keeps its row: it stays in entries(), saying it is down, so the list never shrinks (#942 stage 6).
    expect(mesh.entries().map((entry) => entry.target.hostId)).toEqual(["a", "b", "c"]);
    expect(mesh.entries()[0]?.state.phase).toBe("failed");
  });

  it("shows the selected member's state, and switching shows another without closing any", () => {
    const { mesh, made } = running(settingsWith([member("a"), member("b")], "a"));
    expect(mesh.state.phase).toBe("open");
    mesh.select("b");
    expect(mesh.settings.hostId).toBe("b");
    expect(mesh.state.phase).toBe("open");
    expect(made.every((connection) => connection.stopped === 0)).toBe(true);
  });

  it("an edit applies only the fields it changed, onto the settings as they are now (#1006)", () => {
    const { mesh } = running(settingsWith([member("a"), member("b")], "a"));
    // A form read the settings when it opened; the shown machine changed after that.
    const opened = mesh.settings;
    mesh.select("b");
    const { members: currentMembers, ...current } = mesh.settings;
    mesh.edit({ token: "fresh" });
    const { members, ...after } = mesh.settings;
    expect(after).toEqual({ ...current, token: "fresh" });
    expect(members.map((entry) => entry.hostId).toSorted()).toEqual(
      currentMembers.map((entry) => entry.hostId).toSorted(),
    );
    expect(mesh.settings.hostId).not.toBe(opened.hostId);
  });

  it("a whole-copy commit after another machine was picked restores the pick, which edit() keeps (#1168)", () => {
    const { mesh } = running(settingsWith([member("a"), member("b")], "a"));
    // A form read the settings when it opened; the shown machine moved on after that.
    const opened = mesh.settings;
    mesh.select("b");
    // The old component committed that copy, which put the selection back where the form found it (#1006).
    mesh.update({ ...opened, token: "fresh" });
    expect(mesh.settings.hostId).toBe("a");
    // edit() saves one field onto the settings as they are now, so the machine picked while the form was open stays.
    mesh.select("b");
    mesh.edit({ token: "fresh" });
    expect(mesh.settings.hostId).toBe("b");
  });

  it("dials only the members the roster added, and stops one that left it", () => {
    const { mesh, made } = running(settingsWith([member("a"), member("b")]));
    made[0]?.fail();
    mesh.update(settingsWith([member("a"), member("c")], "a"));
    expect(made).toHaveLength(3);
    expect(made[1]?.stopped).toBe(1);
    expect(mesh.entries().map((entry) => entry.target.hostId)).toEqual(["a", "c"]);
  });

  it("gives a member's store a saver that writes nothing, so it cannot replace the roster", () => {
    const { savers } = harness(settingsWith([member("a"), member("b")]));
    const before = loadSettings();
    for (const save of savers) save(settingsWith([member("only")]));
    expect(loadSettings()).toEqual(before);
    expect(savers).toHaveLength(2);
  });

  it("folds a name a member answers with back into the roster", () => {
    const { mesh, made } = running(settingsWith([member("a"), member("b")]));
    made[0]?.fail();
    const renamed = mesh.entries().find((entry) => entry.target.hostId === "a");
    expect(renamed?.target.hostName).toBe("renamed");
    expect(mesh.settings.members.map((entry) => entry.hostName)).toContain("renamed");
  });

  it("still dials this computer's own host in loopback, which has no mesh id", () => {
    const { mesh, made } = running({ ...DEFAULT_SETTINGS, mode: "loopback", loopbackUrl: "ws://127.0.0.1:7766/v1/hc" });
    expect(made).toHaveLength(1);
    expect(mesh.entries()).toHaveLength(1);
  });

  it("keeps the shown machine when it drops after it was reached, though another member is open (#2464)", () => {
    const { mesh, made } = running(settingsWith([member("a"), member("b")], "a"));
    expect(mesh.settings.hostId).toBe("a");
    made[0]?.fail();
    expect(mesh.settings.hostId).toBe("a");
    expect(mesh.state.phase).toBe("failed");
  });

  it("moves the shown machine off one not reached since the start, to a member that is open", () => {
    storing(settingsWith([member("a"), member("b")], "a"));
    const { mesh, made } = harness(settingsWith([member("a"), member("b")], "a"));
    made[1]?.start();
    made[0]?.fail();
    expect(mesh.settings.hostId).toBe("b");
    expect(mesh.state.phase).toBe("open");
    // Shown, not saved: a later start opens the machine the person chose again (#2532).
    expect(loadSettings().hostId).toBe("a");
  });

  it("keeps a start on the machine whose space or terminal the address names while a retry can bring it back (#2532)", () => {
    const { mesh, made } = harness(settingsWith([member("a"), member("b")], "a"), () => true);
    made[0]?.connecting();
    made[1]?.start();
    made[0]?.fail();
    expect(mesh.settings.hostId).toBe("a");
    expect(mesh.state.phase).toBe("failed");
  });

  it("keeps a machine the person picked though it was not reached yet and its redial fails (#2532, #2505 review)", () => {
    const { mesh, made } = harness(settingsWith([member("a"), member("b")], "a"));
    made[0]?.start();
    mesh.select("b");
    made[1]?.fail();
    expect(mesh.settings.hostId).toBe("b");
    expect(mesh.state.phase).toBe("failed");
  });

  it("a final failure still moves a start off its machine, though the address names a place on it (#2535 review)", () => {
    const { mesh, made } = harness(settingsWith([member("a"), member("b")], "a"), () => true);
    made[0]?.connecting();
    made[1]?.start();
    made[0]?.fail(null);
    expect(mesh.settings.hostId).toBe("b");
  });

  it("an edit to how the app dials keeps the machine a failover shows, not the one that is down (#2535 review)", () => {
    const { mesh, made } = harness(settingsWith([member("a"), member("b")], "a"));
    made[1]?.start();
    made[0]?.fail();
    expect(mesh.settings.hostId).toBe("b");
    mesh.edit({});
    expect(mesh.settings.hostId).toBe("b");
  });

  it("opening, on purpose, the machine a failover shows saves it (#2535 review)", () => {
    storing(settingsWith([member("a"), member("b")], "a"));
    const { mesh, made } = harness(settingsWith([member("a"), member("b")], "a"));
    made[1]?.start();
    made[0]?.fail();
    mesh.select("b");
    expect(loadSettings().hostId).toBe("b");
  });

  it("does not move off a machine that is only connecting", () => {
    const { mesh, made } = running(settingsWith([member("a"), member("b")], "a"));
    made[0]?.connecting();
    expect(mesh.settings.hostId).toBe("a");
  });

  it("retries the machine whose row was clicked, not every member", () => {
    const { mesh, made } = running(settingsWith([member("a"), member("b")]));
    mesh.retry("b");
    expect(made[1]?.retries).toBe(1);
    expect(made[0]?.retries).toBe(0);
  });

  it("keeps this computer's own-host starter for every connection built later", () => {
    const { mesh, made } = running({ ...DEFAULT_SETTINGS, mode: "relay" });
    expect(made).toHaveLength(0);
    mesh.restartsLocalHost({
      start: async () => ({ url: "ws://127.0.0.1:1", token: "t" }),
      failure: () => ({}) as never,
    });
    mesh.pair({ ...settingsWith([member("c")], "c"), members: [] });
    expect(made).toHaveLength(1);
    expect(made[0]?.starters).toBe(1);
  });

  it("does not give a newly paired machine the name of the one before it", () => {
    const previous = settingsWith([member("a", "Air")], "a");
    const { mesh } = running(previous);
    mesh.pair({ ...previous, hostId: "c", hostKey: "k-c", directUrl: "", members: [] });
    expect(mesh.settings.hostName).toBe("");
    expect(mesh.entries().find((entry) => entry.target.hostId === "c")?.target.hostName).toBe("");
    expect(mesh.entries().find((entry) => entry.target.hostId === "a")?.target.hostName).toBe("Air");
  });

  it("pairing keeps the machines already held, so one phone reaches several computers (#942)", () => {
    const { mesh, made } = running(settingsWith([member("a"), member("b")]));
    mesh.pair({ ...settingsWith([member("c")], "c"), members: [member("a"), member("b")] });
    expect(mesh.entries().map((entry) => entry.target.hostId)).toContain("c");
    expect(mesh.entries().map((entry) => entry.target.hostId)).toContain("a");
    expect(mesh.entries().map((entry) => entry.target.hostId)).toContain("b");
    expect(made.map((connection) => connection.settings.hostId)).toContain("c");
    expect(made.find((connection) => connection.settings.hostId === "a")?.stopped).toBe(0);
  });

  it("an ordinary edit keeps the roster rather than replacing it", () => {
    const initial = settingsWith([member("a"), member("b")]);
    const { mesh } = running(initial);
    mesh.update({ ...initial, relayUrl: "wss://relay.example" });
    expect(mesh.entries().map((entry) => entry.target.hostId)).toEqual(["a", "b"]);
  });

  it("a new relay reaches the members already dialled, and leaves the untouched ones alone", () => {
    const initial = settingsWith([member("a"), member("b")]);
    const { mesh, made } = running(initial);
    const before = made.map((connection) => connection.settings.relayUrl);
    mesh.update({ ...initial, relayUrl: "wss://relay.example" });
    expect(made.map((connection) => connection.settings.relayUrl)).toEqual([
      "wss://relay.example",
      "wss://relay.example",
    ]);
    expect(before).not.toEqual(["wss://relay.example", "wss://relay.example"]);
    expect(made.every((connection) => connection.stopped === 0)).toBe(true);
  });

  it("an edit that concerns no member does not touch their settings", () => {
    const initial = settingsWith([member("a"), member("b")]);
    const { mesh, made } = running(initial);
    const held = made[0]?.settings;
    mesh.update({ ...initial, members: [...initial.members] });
    expect(made[0]?.settings).toBe(held);
  });

  it("reports unconfigured when there is no roster and nothing paired", () => {
    const { mesh, made } = running({ ...DEFAULT_SETTINGS, mode: "relay" });
    expect(made).toHaveLength(0);
    expect(mesh.state.phase).toBe("unconfigured");
  });

  it("answers the same list until something changes, so a rendering store does not loop", () => {
    const { mesh, made } = running(settingsWith([member("a"), member("b")]));
    const first = mesh.entries();
    expect(mesh.entries()).toBe(first);
    made[0]?.fail();
    const second = mesh.entries();
    expect(second).not.toBe(first);
    expect(second.find((entry) => entry.target.hostId === "a")?.state.phase).toBe("failed");
  });
});
