import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ActionsPaused } from "../keys/dispatcher.ts";
import { pushChannel } from "./push-channel.ts";
import { type PresenceSink, usePushPresence } from "./use-push-presence.ts";

// bun test has no DOM: the hook reads `document`, and React's client renderer reads `window` and a container. These
// stand in for exactly what is read, and are taken away after each test.
interface PageStub extends EventTarget {
  visibilityState: DocumentVisibilityState;
  focused: boolean;
  hasFocus(): boolean;
}

// React looks for a focused iframe after a commit; with no active element, nothing here is one.
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

let page: PageStub;
let root: Root;

beforeEach(() => {
  page = Object.assign(new EventTarget(), {
    visibilityState: "visible" as DocumentVisibilityState,
    focused: true,
    hasFocus(this: PageStub) {
      return this.focused;
    },
  });
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, window: view, document: page });
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  for (const key of ["IS_REACT_ACT_ENVIRONMENT", "window", "document"]) Reflect.deleteProperty(globalThis, key);
});

const recorder = () => {
  const told: (string | null)[] = [];
  const sink: PresenceSink = { focus: (terminal) => void told.push(terminal) };
  return { told, sink };
};

function Presence({ terminal, sinks }: { terminal: string | null; sinks: readonly (PresenceSink | null)[] }) {
  usePushPresence(terminal, sinks);
  return null;
}

const show = (underSettings: boolean, sinks: readonly (PresenceSink | null)[]) =>
  act(async () =>
    root.render(
      <ActionsPaused.Provider value={underSettings}>
        <Presence terminal="t1" sinks={sinks} />
      </ActionsPaused.Provider>,
    ),
  );

describe("the pane the mounted hook reports as shown (#1211)", () => {
  test("Settings, read from ActionsPaused, tells both sinks no pane is shown; closing it tells them the pane again", async () => {
    const push = recorder();
    const desktop = recorder();
    const sinks = [push.sink, desktop.sink];
    const latest = () => [push.told.at(-1), desktop.told.at(-1)];
    await show(false, sinks);
    expect(latest()).toEqual(["t1", "t1"]);
    await show(true, sinks);
    expect(latest()).toEqual([null, null]);
    await show(false, sinks);
    expect(latest()).toEqual(["t1", "t1"]);
  });

  test("a page that is hidden or unfocused shows no pane, and focus or visibility coming back shows it again", async () => {
    const push = recorder();
    const desktop = recorder();
    page.focused = false;
    await show(false, [push.sink, desktop.sink]);
    await act(async () => {
      page.focused = true;
      dispatchEvent(new Event("focus"));
    });
    await act(async () => {
      page.visibilityState = "hidden";
      page.dispatchEvent(new Event("visibilitychange"));
    });
    await act(async () => {
      page.visibilityState = "visible";
      page.dispatchEvent(new Event("visibilitychange"));
    });
    expect(push.told).toEqual([null, "t1", null, "t1"]);
    expect(desktop.told).toEqual([null, "t1", null, "t1"]);
  });

  test("by default the push stream is told, and told no pane once the workspace goes", async () => {
    const focus = spyOn(pushChannel, "focus").mockImplementation(() => undefined);
    try {
      await act(async () => root.render(<DefaultPresence />));
      await act(async () => root.render(null));
      expect(focus.mock.calls).toEqual([["t1"], [null]]);
    } finally {
      focus.mockRestore();
    }
  });
});

function DefaultPresence() {
  usePushPresence("t1");
  return null;
}
