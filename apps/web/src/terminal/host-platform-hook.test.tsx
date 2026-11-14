import { afterEach, beforeEach, expect, test } from "bun:test";
import type { HcConnection } from "@doriface/client";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { StorageLike } from "../storage/guarded.ts";
import { useHostPlatform } from "./host-os.ts";
import type { HostPlatform } from "./keys.ts";
import { rememberHostOs } from "./known-host-os.ts";

// bun test has no DOM: React's client renderer reads `window` and a container, and the hook reads localStorage. These
// stand in for exactly what is read, and are taken away after each test (the pattern of use-push-presence-hook.test.tsx).
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

const memory = (): StorageLike => {
  const items = new Map<string, string>();
  return {
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => void items.set(key, value),
    removeItem: (key) => void items.delete(key),
  };
};

let root: Root;
let storage: StorageLike;
beforeEach(() => {
  storage = memory();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, window: view, document: { activeElement: null } });
  Object.assign(globalThis, { localStorage: storage });
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  for (const key of ["IS_REACT_ACT_ENVIRONMENT", "window", "document", "localStorage"])
    Reflect.deleteProperty(globalThis, key);
});

/** The line a Mac had before it dropped: still handed in, but every call on it now fails. */
const dropped = {
  hello: { core: { id: "core-a", name: "m942-a" } },
  call: () => Promise.reject(new Error("the connection is closed")),
} as unknown as HcConnection;

function Platform({ seen }: { readonly seen: HostPlatform[] }): null {
  seen.push(useHostPlatform(dropped, undefined, true, "host-a"));
  return null;
}

test("a Mac reached before keeps its keys after its line drops mid-session, though the stale line's read fails (#2385)", async () => {
  rememberHostOs(storage, "host-a", "darwin");
  const seen: HostPlatform[] = [];
  await act(async () => root.render(<Platform seen={seen} />));
  await act(async () => {
    await Promise.resolve();
  });
  expect(seen.at(-1)).toBe("mac");
});
