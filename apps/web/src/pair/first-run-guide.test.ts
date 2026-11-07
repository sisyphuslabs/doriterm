import { describe, expect, test } from "bun:test";
import { GUIDE_KEY, type GuideState, GuideStore, guideSteps, loadGuide } from "./first-run-guide.ts";

function memory(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
    data,
  };
}

const states = (steps: ReturnType<typeof guideSteps>) => steps.map((step) => `${step.id}:${step.state}`);

describe("first-run guide", () => {
  test("is off until a pairing starts it, and an unreadable record reads as off", () => {
    const off: GuideState = { status: "off", opened: false, address: null };
    expect(loadGuide(memory())).toEqual(off);
    expect(loadGuide(memory({ [GUIDE_KEY]: "{" }))).toEqual(off);
    expect(loadGuide(memory({ [GUIDE_KEY]: '{"status":"sideways"}' }))).toEqual(off);
  });

  test("steps complete in order, each on its own event", () => {
    const store = new GuideStore(memory());
    store.start();
    const hidden = { listVisible: false, live: [] };
    expect(states(guideSteps(store.value, hidden))).toEqual(["pair:done", "agent:current", "list:todo"]);
    // Live terminals on the host do not complete a step this device has not taken.
    expect(states(guideSteps(store.value, { listVisible: true, live: ["m/1"] }))).toEqual([
      "pair:done",
      "agent:current",
      "list:todo",
    ]);
    store.opened("m/1");
    expect(states(guideSteps(store.value, { listVisible: false, live: ["m/1"] }))).toEqual([
      "pair:done",
      "agent:done",
      "list:current",
    ]);
    expect(states(guideSteps(store.value, { listVisible: true, live: ["m/1"] }))).toEqual([
      "pair:done",
      "agent:done",
      "list:done",
    ]);
  });

  test("survives a reload, can be skipped, and Settings starts it over", () => {
    const storage = memory();
    const store = new GuideStore(storage);
    store.start();
    store.opened("m/1");
    expect(new GuideStore(storage).value).toEqual({ status: "active", opened: true, address: "m/1" });
    store.skip();
    expect(new GuideStore(storage).value.status).toBe("skipped");
    store.opened("m/2");
    expect(store.value.address).toBe("m/1");
    store.start();
    expect(store.value).toEqual({ status: "active", opened: false, address: null });
    store.finish();
    expect(loadGuide(storage).status).toBe("done");
  });

  test("a terminal opened while the guide is not running is not remembered for a later start", () => {
    const store = new GuideStore(memory());
    store.opened("m/1");
    expect(store.value).toEqual({ status: "off", opened: false, address: null });
  });

  test("the list step waits for the terminal this device opened, not one the host already had (#834)", () => {
    const store = new GuideStore(memory());
    store.start();
    store.opened("m/2");
    // The host's own shell is live; the one this device opened is not listed live yet.
    expect(states(guideSteps(store.value, { listVisible: true, live: ["m/1"] }))).toEqual([
      "pair:done",
      "agent:done",
      "list:current",
    ]);
    expect(states(guideSteps(store.value, { listVisible: true, live: ["m/1", "m/2"] }))).toEqual([
      "pair:done",
      "agent:done",
      "list:done",
    ]);
    // Opening another terminal makes it the one the step waits for.
    store.opened("m/1");
    expect(states(guideSteps(store.value, { listVisible: true, live: ["m/1"] })).at(-1)).toBe("list:done");
  });

  test("a record an older app saved, which names no terminal, still completes on any live one (#834)", () => {
    const store = new GuideStore(memory({ [GUIDE_KEY]: '{"status":"active","opened":true}' }));
    expect(store.value).toEqual({ status: "active", opened: true, address: null });
    expect(states(guideSteps(store.value, { listVisible: true, live: ["m/1"] })).at(-1)).toBe("list:done");
  });
});
