import { describe, expect, test } from "bun:test";
import { DEFAULT_RELAY_URL, DEFAULT_SETTINGS, loadSettings, saveSettings, staysOnThisComputer } from "./settings.ts";

test.each([
  ["ws://127.0.0.1:7766/v1/hc", true],
  ["ws://127.8.0.1:7766/v1/hc", true],
  ["ws://localhost:52011/v1/hc", true],
  ["ws://[::1]:52011/v1/hc", true],
  ["ws://192.168.0.4:7766/v1/hc", false],
  ["ws://studio.lan:7766/v1/hc", false],
  ["ws://127.0.0.1.example.com/v1/hc", false],
  ["not a url", false],
])("a loopback gateway at %s stays on this computer: %p", (loopbackUrl, expected) => {
  expect(staysOnThisComputer({ ...DEFAULT_SETTINGS, mode: "loopback", loopbackUrl })).toBe(expected);
});

test("a relay link never stays on this computer", () => {
  expect(staysOnThisComputer({ ...DEFAULT_SETTINGS, loopbackUrl: "ws://127.0.0.1:7766/v1/hc" })).toBe(false);
});

/** A Storage holding one saved connection, as a browser that once had a custom relay typed in would. */
function saved(value: object): Storage {
  const items = new Map([["doriface.connection", JSON.stringify(value)]]);
  return {
    length: items.size,
    clear: () => items.clear(),
    getItem: (key) => items.get(key) ?? null,
    key: () => null,
    removeItem: (key) => void items.delete(key),
    setItem: (key, item) => void items.set(key, item),
  };
}

const CUSTOM = { ...DEFAULT_SETTINGS, relayUrl: "wss://relay.custom.invalid", hostId: "h", hostKey: "k" };
/** A file written before the roster existed: its one host becomes a roster of one, selected. */
const CUSTOM_ROSTER = { ...CUSTOM, members: [{ hostId: "h", hostName: "", hostKey: "k", directUrl: "" }] };

test("a release build ignores a saved custom relay address and uses the production relay", () => {
  expect(loadSettings(saved(CUSTOM), { devBuild: false })).toEqual({ ...CUSTOM_ROSTER, relayUrl: DEFAULT_RELAY_URL });
});

test("a dev build keeps a saved custom relay address", () => {
  expect(loadSettings(saved(CUSTOM), { devBuild: true }).relayUrl).toBe("wss://relay.custom.invalid");
});

test("a saved host name comes back on a fresh load, so a host that is not answering is still named (#496)", () => {
  expect(loadSettings(saved({ ...CUSTOM, hostName: "studio" }), { devBuild: false }).hostName).toBe("studio");
});

test("with no localStorage at all, as under bun's test runner, the defaults (#490)", () => {
  expect(Reflect.get(globalThis, "localStorage")).toBeUndefined();
  expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
});

describe("the roster stage 3 needs", () => {
  test("a file written before the roster existed becomes a roster of one, still selected", () => {
    const loaded = loadSettings(saved({ ...CUSTOM, hostName: "studio" }), { devBuild: false });
    expect(loaded.members).toEqual([{ hostId: "h", hostName: "studio", hostKey: "k", directUrl: "" }]);
    expect(loaded.hostId).toBe("h");
  });

  test("a saved roster keeps every member, the selected one first", () => {
    const saved2 = {
      ...CUSTOM,
      members: [
        { hostId: "b", hostName: "laptop", hostKey: "kb", directUrl: "" },
        { hostId: "h", hostName: "studio", hostKey: "k", directUrl: "" },
        { hostId: "c", hostName: "tablet", hostKey: "kc", directUrl: "" },
      ],
    };
    const loaded = loadSettings(saved(saved2), { devBuild: false });
    expect(loaded.members.map((member) => member.hostId)).toEqual(["h", "b", "c"]);
  });

  test("a roster that lost the selected host is repaired rather than leaving the app bound to nothing", () => {
    const saved2 = { ...CUSTOM, members: [{ hostId: "b", hostName: "laptop", hostKey: "kb", directUrl: "" }] };
    expect(loadSettings(saved(saved2), { devBuild: false }).members.map((member) => member.hostId)).toEqual(["h", "b"]);
  });

  test("a member without a host id is dropped instead of becoming an address nobody can reach", () => {
    const saved2 = { ...CUSTOM, members: [{ hostName: "ghost" }, { hostId: "b", hostName: "laptop", hostKey: "kb" }] };
    expect(loadSettings(saved(saved2), { devBuild: false }).members.map((member) => member.hostId)).toEqual(["h", "b"]);
  });
});

describe("saving keeps the roster and the selected host in agreement", () => {
  test("a settings object with no roster still writes the host it is bound to", () => {
    const items = new Map<string, string>();
    const storage = {
      length: 0,
      clear: () => items.clear(),
      getItem: (key: string) => items.get(key) ?? null,
      key: () => null,
      removeItem: (key: string) => void items.delete(key),
      setItem: (key: string, value: string) => void items.set(key, value),
    };
    saveSettings({ ...CUSTOM, members: [] }, storage);
    const written = JSON.parse(items.get("doriface.connection") ?? "{}") as { members?: { hostId: string }[] };
    expect(written.members?.map((member) => member.hostId)).toEqual(["h"]);
  });
});
