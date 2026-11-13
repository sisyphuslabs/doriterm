import { describe, expect, it } from "bun:test";
import { MeshConnections, type MemberConnection, type StoreFactory } from "./mesh-connections.ts";
import { DEFAULT_SETTINGS, type ConnectionSettings } from "./settings.ts";

/** What a pairing hands over for one machine: the selected host, with no roster of its own. */
const pairing = (hostId: string): ConnectionSettings => ({
  ...DEFAULT_SETTINGS,
  hostId,
  hostKey: `key-${hostId}`,
});

/** One member's store, standing in for the real connection: it counts being dialled and stopped, and answers nothing. */
class QuietStore implements MemberConnection {
  settings: ConnectionSettings;
  readonly state: MemberConnection["state"] = { phase: "unconfigured" };
  started = 0;
  stopped = 0;

  constructor(settings: ConnectionSettings) {
    this.settings = settings;
  }

  subscribe(): () => void {
    return () => undefined;
  }

  start(): void {
    this.started += 1;
  }

  adopt(): void {}

  stop(): void {
    this.stopped += 1;
  }

  retryNow(): void {}
  nudge(): void {}

  update(settings: ConnectionSettings): void {
    this.settings = settings;
  }

  restoring(): void {}

  restartsLocalHost(): void {}

  hostStartFailed(): void {}
}

const harness = () => {
  const made: QuietStore[] = [];
  const factory: StoreFactory = (settings) => {
    const store = new QuietStore(settings);
    made.push(store);
    return store;
  };
  return { mesh: new MeshConnections(DEFAULT_SETTINGS, factory), made };
};

describe("pairing a second machine adds it (#942)", () => {
  it("keeps the machine paired first, and the one just paired is shown first", () => {
    const { mesh, made } = harness();
    mesh.pair(pairing("a"));
    mesh.pair(pairing("b"));
    // The machine held first keeps its row, and the machine just paired joins at the end.
    expect(mesh.entries().map((entry) => entry.target.hostId)).toEqual(["a", "b"]);
    expect(made.find((store) => store.settings.hostId === "a")?.stopped).toBe(0);
    expect(made.find((store) => store.settings.hostId === "b")?.started).toBe(1);
  });
});
