import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { pushChannel } from "./push-channel.ts";
import { listenForNotices, useNoticeOpen } from "./notice-open.ts";

// #1181: a tap while the app is open reaches the page as a service worker message, not through the address.
// bun test has no DOM: these stand in for the service worker container, the page's origin, and what React's client
// renderer reads, and are taken away after each test.
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

const NOTICE = "n".repeat(22);
let worker: EventTarget;
let root: Root;

beforeEach(() => {
  worker = new EventTarget();
  Object.defineProperty(navigator, "serviceWorker", { value: worker, configurable: true });
  Object.assign(globalThis, {
    IS_REACT_ACT_ENVIRONMENT: true,
    window: view,
    location: { origin: "https://app.invalid" },
  });
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  mock.restore();
  Reflect.deleteProperty(navigator, "serviceWorker");
  for (const key of ["IS_REACT_ACT_ENVIRONMENT", "window", "location"]) Reflect.deleteProperty(globalThis, key);
});

function NoticeOpen({ open }: { open: (address: string) => void }) {
  useNoticeOpen("h", open);
  return null;
}

test("a notice the service worker posts goes to the workspace and opens the pane it is about", async () => {
  const request = spyOn(pushChannel, "requestOnce").mockResolvedValue({ t: "notice", terminal: "t9", kind: "input" });
  const toWorkspace = mock(() => undefined);
  listenForNotices(toWorkspace);

  worker.dispatchEvent(new MessageEvent("message", { data: { type: "other", url: `/?notice=${NOTICE}&host=h` } }));
  expect(toWorkspace).not.toHaveBeenCalled();
  worker.dispatchEvent(
    new MessageEvent("message", { data: { type: "doriface-notice", url: `/?notice=${NOTICE}&host=h` } }),
  );
  expect(toWorkspace).toHaveBeenCalledTimes(1);

  const { promise: opened, resolve } = Promise.withResolvers<string>();
  await act(async () => root.render(<NoticeOpen open={resolve} />));
  // The pending notice was set: the workspace asks the host which terminal it is about, and opens that one.
  expect(request.mock.calls).toEqual([[{ t: "notice", id: NOTICE }]]);
  expect(await opened).toBe("t9");
});
