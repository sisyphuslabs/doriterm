import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { type ConnectionSettings, DEFAULT_SETTINGS } from "../connection/settings.ts";
import { type PairedHostStore, usePairedHost } from "./mesh-section.tsx";

// bun test has no DOM: React's client renderer reads `window` and a container, which stand in here and go after each test.
const view = { HTMLIFrameElement: function NoFrame() {}, document: { activeElement: null } };
const container = {
  nodeType: 1,
  nodeName: "DIV",
  tagName: "DIV",
  namespaceURI: "http://www.w3.org/1999/xhtml",
  addEventListener() {},
  removeEventListener() {},
  ownerDocument: { addEventListener() {}, removeEventListener() {}, defaultView: view },
} as unknown as Element;

let root: Root;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, window: view });
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  for (const key of ["IS_REACT_ACT_ENVIRONMENT", "window"]) Reflect.deleteProperty(globalThis, key);
});

/** A connection store whose settings a test changes, telling its subscribers as the app's store does. */
function settingsStore(initial: ConnectionSettings) {
  let settings = initial;
  const listeners = new Set<() => void>();
  const store: PairedHostStore & { change(fields: Partial<ConnectionSettings>): void } = {
    get settings() {
      return settings;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    change(fields) {
      settings = { ...settings, ...fields };
      for (const listener of listeners) listener();
    },
  };
  return store;
}

test("the host the Mesh banners check against follows a change of mode and of the shown machine (#1132, #2023)", async () => {
  const store = settingsStore({ ...DEFAULT_SETTINGS, mode: "loopback", hostId: "a" });
  const seen: (string | undefined)[] = [];
  function Probe() {
    seen.push(usePairedHost(store));
    return null;
  }
  await act(async () => root.render(<Probe />));
  await act(async () => store.change({ mode: "relay" }));
  await act(async () => store.change({ hostId: "b" }));
  await act(async () => store.change({ mode: "loopback" }));
  // Loopback checks against no paired host; relay against the shown machine, as it changes. Repeated renders of one
  // value are folded: what counts is each value the banner was shown.
  const shown = seen.filter((value, index) => index === 0 || value !== seen[index - 1]);
  expect(shown).toEqual([undefined, "a", "b", undefined]);
});
