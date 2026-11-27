import { expect, test } from "bun:test";
import { firstUpdateOrTeardown, setEdgeProbe, startEdgeProbe } from "./edge-probe.ts";

function fakes() {
  const stored = new Map<string, string>();
  const shown = { on: 0, off: 0 };
  return {
    stored,
    shown,
    deps: {
      storage: {
        getItem: (key: string) => stored.get(key) ?? null,
        setItem: (key: string, value: string) => void stored.set(key, value),
      },
      show: () => (shown.on++, () => void shown.off++),
    },
  };
}

// A Home Screen app has no address bar, so the readout is switched on from Settings and remembered for the next launch.
test("the Settings switch shows the readout now, hides it, and a later launch starts it again from the stored choice", () => {
  const { stored, shown, deps } = fakes();
  setEdgeProbe(true, deps);
  setEdgeProbe(true, deps);
  expect(shown).toEqual({ on: 1, off: 0 });
  setEdgeProbe(false, deps);
  expect(shown).toEqual({ on: 1, off: 1 });
  expect(stored.get("doriface.debug.edge-probe")).toBe("0");
  stored.set("doriface.debug.edge-probe", "1");
  startEdgeProbe("", deps);
  expect(shown.on).toBe(2);
  setEdgeProbe(false, deps);
});

test("?edgeprobe=1 shows it for this visit without remembering it, and nothing starts it when neither asks", () => {
  const { stored, shown, deps } = fakes();
  startEdgeProbe("", deps);
  expect(shown.on).toBe(0);
  startEdgeProbe("?edgeprobe=1", deps);
  expect(shown.on).toBe(1);
  expect(stored.has("doriface.debug.edge-probe")).toBe(false);
  setEdgeProbe(false, deps, false);
});

test("a readout that throws at launch is reported, the stored switch turns off, and the app keeps starting", () => {
  const stored = new Map([["doriface.debug.edge-probe", "1"]]);
  const reported: unknown[] = [];
  const deps = {
    storage: {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => void stored.set(key, value),
    },
    show: (): (() => void) => {
      throw new Error("no body");
    },
  };
  expect(() => startEdgeProbe("", deps, (error) => reported.push(error))).not.toThrow();
  expect(reported).toHaveLength(1);
  expect(stored.get("doriface.debug.edge-probe")).toBe("0");
});

test("the switch stores on only after the readout showed", () => {
  const stored = new Map<string, string>();
  const deps = {
    storage: {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => void stored.set(key, value),
    },
    show: (): (() => void) => {
      throw new Error("no body");
    },
  };
  expect(() => setEdgeProbe(true, deps)).toThrow();
  expect(stored.has("doriface.debug.edge-probe")).toBe(false);
});

test("a readout whose first update throws removes what it added and passes the error on", () => {
  let tornDown = 0;
  expect(() =>
    firstUpdateOrTeardown(
      () => {
        throw new Error("no adoptedStyleSheets");
      },
      () => void tornDown++,
    ),
  ).toThrow("no adoptedStyleSheets");
  expect(tornDown).toBe(1);
  const stop = firstUpdateOrTeardown(
    () => undefined,
    () => void tornDown++,
  );
  expect(tornDown).toBe(1);
  stop();
  expect(tornDown).toBe(2);
});
