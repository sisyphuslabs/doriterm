import { describe, expect, test } from "bun:test";
import { ScreenAwake, type ScreenWakeLock, type Visibility, type WakeLockHandle } from "./wake-lock.ts";

/** A wake lock that counts what it hands out and can refuse, like `navigator.wakeLock`. */
function fakeLock() {
  const state = { active: 0, requests: 0, refuse: false, gate: Promise.resolve() };
  const handles: (WakeLockHandle & { drop: () => void })[] = [];
  const lock: ScreenWakeLock = {
    request: async () => {
      state.requests += 1;
      await state.gate;
      if (state.refuse) throw new DOMException("not allowed", "NotAllowedError");
      state.active += 1;
      const events = new EventTarget();
      let released = false;
      const drop = (): void => {
        if (released) return;
        released = true;
        state.active -= 1;
        events.dispatchEvent(new Event("release"));
      };
      const handle = {
        release: async () => drop(),
        addEventListener: (type: "release", listener: () => void) => events.addEventListener(type, listener),
        drop,
      };
      handles.push(handle);
      return handle;
    },
  };
  return { state, lock, handles };
}

function fakePage() {
  const events = new EventTarget();
  const page = {
    visibilityState: "visible" as DocumentVisibilityState,
    addEventListener: (type: "visibilitychange", listener: () => void) => events.addEventListener(type, listener),
  } satisfies Visibility;
  /** Flips visibility the way the browser does, then waits for the holder to act on the event. */
  const show = async (state: DocumentVisibilityState, awake: ScreenAwake): Promise<void> => {
    page.visibilityState = state;
    events.dispatchEvent(new Event("visibilitychange"));
    await awake.settled();
  };
  return { page, show };
}

describe("ScreenAwake", () => {
  test("holds the lock only while it is wanted", async () => {
    const { state, lock } = fakeLock();
    const awake = new ScreenAwake(lock, fakePage().page);
    expect(state.requests).toBe(0);
    await awake.want(true);
    expect([state.active, awake.held]).toEqual([1, true]);
    await awake.want(false);
    expect([state.active, awake.held]).toEqual([0, false]);
  });

  test("releases the lock when the page is hidden and takes it again when it is shown", async () => {
    const { state, lock } = fakeLock();
    const { page, show } = fakePage();
    const awake = new ScreenAwake(lock, page);
    await awake.want(true);
    await show("hidden", awake);
    expect([state.active, awake.held]).toEqual([0, false]);
    await show("visible", awake);
    expect([state.active, state.requests, awake.held]).toEqual([1, 2, true]);
  });

  test("asks again after the system dropped the lock, once the page is shown", async () => {
    const { state, lock, handles } = fakeLock();
    const { page, show } = fakePage();
    const awake = new ScreenAwake(lock, page);
    await awake.want(true);
    handles[0]?.drop();
    expect(awake.held).toBe(false);
    await show("visible", awake);
    expect([state.active, awake.held]).toEqual([1, true]);
  });

  test("a refused request is not repeated until the page is shown again", async () => {
    const { state, lock } = fakeLock();
    const { page, show } = fakePage();
    state.refuse = true;
    const awake = new ScreenAwake(lock, page);
    await awake.want(true);
    await awake.want(true);
    expect([state.requests, awake.held]).toEqual([1, false]);
    state.refuse = false;
    await show("visible", awake);
    expect([state.requests, awake.held]).toEqual([2, true]);
  });

  test("a lock granted after the wish was withdrawn is released at once", async () => {
    const { state, lock } = fakeLock();
    const gate = Promise.withResolvers<void>();
    state.gate = gate.promise;
    const awake = new ScreenAwake(lock, fakePage().page);
    const asked = awake.want(true);
    const withdrawn = awake.want(false);
    gate.resolve();
    await Promise.all([asked, withdrawn]);
    expect([state.requests, state.active, awake.held]).toEqual([1, 0, false]);
  });

  test("a page hidden from the start asks for nothing", async () => {
    const { state, lock } = fakeLock();
    const { page } = fakePage();
    page.visibilityState = "hidden";
    const awake = new ScreenAwake(lock, page);
    await awake.want(true);
    expect(state.requests).toBe(0);
  });
});
