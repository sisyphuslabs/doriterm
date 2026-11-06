import { describe, expect, test } from "bun:test";
import { GUIDE_KEY, GuideStore, guideSteps, loadGuide } from "./first-run-guide.ts";

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
    expect(loadGuide(memory())).toEqual({ status: "off", opened: false });
    expect(loadGuide(memory({ [GUIDE_KEY]: "{" }))).toEqual({ status: "off", opened: false });
    expect(loadGuide(memory({ [GUIDE_KEY]: '{"status":"sideways"}' }))).toEqual({ status: "off", opened: false });
  });

  test("steps complete in order, each on its own event", () => {
    const store = new GuideStore(memory());
    store.start();
    const hidden = { listVisible: false, listedLive: false };
    expect(states(guideSteps(store.value, hidden))).toEqual(["pair:done", "agent:current", "list:todo"]);
    // Live terminals on the host do not complete a step this device has not taken.
    expect(states(guideSteps(store.value, { listVisible: true, listedLive: true }))).toEqual([
      "pair:done",
      "agent:current",
      "list:todo",
    ]);
    store.opened();
    expect(states(guideSteps(store.value, { listVisible: false, listedLive: true }))).toEqual([
      "pair:done",
      "agent:done",
      "list:current",
    ]);
    expect(states(guideSteps(store.value, { listVisible: true, listedLive: true }))).toEqual([
      "pair:done",
      "agent:done",
      "list:done",
    ]);
  });

  test("survives a reload, can be skipped, and Settings starts it over", () => {
    const storage = memory();
    const store = new GuideStore(storage);
    store.start();
    store.opened();
    expect(new GuideStore(storage).value).toEqual({ status: "active", opened: true });
    store.skip();
    expect(new GuideStore(storage).value.status).toBe("skipped");
    store.opened();
    expect(store.value.opened).toBe(true);
    store.start();
    expect(store.value).toEqual({ status: "active", opened: false });
    store.finish();
    expect(loadGuide(storage).status).toBe("done");
  });

  test("a terminal opened while the guide is not running is not remembered for a later start", () => {
    const store = new GuideStore(memory());
    store.opened();
    expect(store.value).toEqual({ status: "off", opened: false });
  });
});
