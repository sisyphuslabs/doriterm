import { describe, expect, test } from "bun:test";
import type { MachineView } from "@doriface/protocol";
import { machineIds } from "../workspace/tab-keys.ts";
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

const NO_IDS = machineIds([]);
/** One machine, its permanent id fixed, by the name it has now. */
const named = (name: string) => machineIds([{ id: "c0re", name } as MachineView]);
const states = (steps: ReturnType<typeof guideSteps>) => steps.map((step) => `${step.id}:${step.state}`);

describe("first-run guide", () => {
  test("is off until a pairing starts it, and an unreadable record reads as off", () => {
    const off: GuideState = { status: "off", opened: false, key: null };
    expect(loadGuide(memory())).toEqual(off);
    expect(loadGuide(memory({ [GUIDE_KEY]: "{" }))).toEqual(off);
    expect(loadGuide(memory({ [GUIDE_KEY]: '{"status":"sideways"}' }))).toEqual(off);
  });

  test("steps complete in order, each on its own event", () => {
    const store = new GuideStore(memory());
    store.start();
    const hidden = { listVisible: false, live: [], ids: NO_IDS };
    expect(states(guideSteps(store.value, hidden))).toEqual(["pair:done", "agent:current", "list:todo"]);
    // Live terminals on the host do not complete a step this device has not taken.
    expect(states(guideSteps(store.value, { listVisible: true, live: ["m/1"], ids: NO_IDS }))).toEqual([
      "pair:done",
      "agent:current",
      "list:todo",
    ]);
    store.opened("m/1", NO_IDS);
    expect(states(guideSteps(store.value, { listVisible: false, live: ["m/1"], ids: NO_IDS }))).toEqual([
      "pair:done",
      "agent:done",
      "list:current",
    ]);
    expect(states(guideSteps(store.value, { listVisible: true, live: ["m/1"], ids: NO_IDS }))).toEqual([
      "pair:done",
      "agent:done",
      "list:done",
    ]);
  });

  test("survives a reload, can be skipped, and Settings starts it over", () => {
    const storage = memory();
    const store = new GuideStore(storage);
    store.start();
    store.opened("m/1", NO_IDS);
    expect(new GuideStore(storage).value).toEqual({ status: "active", opened: true, key: "name:m/1" });
    store.skip();
    expect(new GuideStore(storage).value.status).toBe("skipped");
    store.opened("m/2", NO_IDS);
    expect(store.value.key).toBe("name:m/1");
    store.start();
    expect(store.value).toEqual({ status: "active", opened: false, key: null });
    store.finish();
    expect(loadGuide(storage).status).toBe("done");
  });

  test("a terminal opened while the guide is not running is not remembered for a later start", () => {
    const store = new GuideStore(memory());
    store.opened("m/1", NO_IDS);
    expect(store.value).toEqual({ status: "off", opened: false, key: null });
  });

  test("the list step waits for the terminal this device opened, not one the host already had (#834)", () => {
    const store = new GuideStore(memory());
    store.start();
    store.opened("m/2", NO_IDS);
    // The host's own shell is live; the one this device opened is not listed live yet.
    expect(states(guideSteps(store.value, { listVisible: true, live: ["m/1"], ids: NO_IDS }))).toEqual([
      "pair:done",
      "agent:done",
      "list:current",
    ]);
    expect(states(guideSteps(store.value, { listVisible: true, live: ["m/1", "m/2"], ids: NO_IDS }))).toEqual([
      "pair:done",
      "agent:done",
      "list:done",
    ]);
    // Opening another terminal makes it the one the step waits for.
    store.opened("m/1", NO_IDS);
    expect(states(guideSteps(store.value, { listVisible: true, live: ["m/1"], ids: NO_IDS })).at(-1)).toBe("list:done");
  });

  test("a record an older app saved, which names no terminal, still completes on any live one (#834)", () => {
    const store = new GuideStore(memory({ [GUIDE_KEY]: '{"status":"active","opened":true}' }));
    expect(store.value).toEqual({ status: "active", opened: true, key: null });
    expect(states(guideSteps(store.value, { listVisible: true, live: ["m/1"], ids: NO_IDS })).at(-1)).toBe("list:done");
  });

  test("a record an app before #1198 saved, which names the terminal by its address, still finds it", () => {
    const store = new GuideStore(memory({ [GUIDE_KEY]: '{"status":"active","opened":true,"address":"m/1"}' }));
    expect(store.value.key).toBe("name:m/1");
    expect(states(guideSteps(store.value, { listVisible: true, live: ["m/1"], ids: NO_IDS })).at(-1)).toBe("list:done");
  });

  test("the list step still finds the terminal this device opened after its machine is renamed (#1198)", () => {
    const store = new GuideStore(memory());
    store.start();
    store.opened("rohan/t1", named("rohan"));
    // The machine is renamed before the list shows the terminal: it is the same terminal, now at gondor/t1.
    const renamed = { listVisible: true, live: ["gondor/t1"], ids: named("gondor") };
    expect(states(guideSteps(store.value, renamed)).at(-1)).toBe("list:done");
    // A terminal of that number on another machine is still not the one this device opened.
    const other = { listVisible: true, live: ["rohan/t1"], ids: named("gondor") };
    expect(states(guideSteps(store.value, other)).at(-1)).toBe("list:current");
  });
});

test("the terminal the guide waits for is the same one after the route moves to another host (#2537)", () => {
  const store = new GuideStore(memory());
  store.start();
  // Opened through core c, where it is the bare t7; through core m it is studio/t7 (m lists c as studio).
  store.opened("t7", machineIds([], "c"));
  const viaM = machineIds([{ id: "c", name: "studio" } as MachineView], "m");
  expect(states(guideSteps(store.value, { listVisible: true, live: ["studio/t7"], ids: viaM }))).toEqual([
    "pair:done",
    "agent:done",
    "list:done",
  ]);
  expect(states(guideSteps(store.value, { listVisible: true, live: ["t7"], ids: viaM }))).toEqual([
    "pair:done",
    "agent:done",
    "list:current",
  ]);
});
