import { expect, test } from "bun:test";
import { setEdgeProbe, startEdgeProbe } from "./edge-probe.ts";

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

test("?edgeprobe=1 starts it, and nothing starts it when neither asks", () => {
  const { shown, deps } = fakes();
  startEdgeProbe("", deps);
  expect(shown.on).toBe(0);
  startEdgeProbe("?edgeprobe=1", deps);
  expect(shown.on).toBe(1);
  setEdgeProbe(false, deps);
});
