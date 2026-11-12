import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { UpdateSetting } from "../desktop/update-setting.ts";
import { useUpdateState } from "./update-channel-row.tsx";

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

afterEach(() => {
  for (const key of ["IS_REACT_ACT_ENVIRONMENT", "window"]) Reflect.deleteProperty(globalThis, key);
});

test("the row stops its status listener when it unmounts, so opening Settings again adds none (#2252)", async () => {
  let live = 0;
  const setting: UpdateSetting = {
    channel: async () => "stable",
    setChannel: async () => true,
    check: async () => undefined,
    onStatus: () => {
      live += 1;
      return () => {
        live -= 1;
      };
    },
  };
  function Probe() {
    useUpdateState(setting);
    return null;
  }
  await act(async () => root.render(<Probe />));
  expect(live).toBe(1);
  await act(async () => root.unmount());
  expect(live).toBe(0);
});
