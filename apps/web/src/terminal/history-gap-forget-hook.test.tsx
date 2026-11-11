import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { dismissHistoryGap, historyGapFor, noteHistoryGap, useForgetEndedHistoryGaps } from "./history-gap-notice.ts";

// bun test has no DOM: React's client renderer reads `window` and a container, as in use-push-presence-hook.test.tsx.
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
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, window: view, document: view.document });
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  for (const address of ["t1", "t2"]) dismissHistoryGap(address);
  for (const key of ["IS_REACT_ACT_ENVIRONMENT", "window", "document"]) Reflect.deleteProperty(globalThis, key);
});

type Feed = readonly { readonly address: string; readonly state: string }[];

function Workspace({ loaded, terminals }: { readonly loaded: boolean; readonly terminals: Feed }) {
  useForgetEndedHistoryGaps(loaded, terminals);
  return null;
}

const feed: Feed = [
  { address: "t1", state: "live" },
  { address: "t2", state: "finished" },
];

test("a terminal the loaded feed lists finished loses its note, and a live one keeps its own (#2292)", async () => {
  noteHistoryGap("t1", "reconnect");
  noteHistoryGap("t2", "reconnect");
  await act(async () => root.render(<Workspace loaded terminals={feed} />));
  expect([historyGapFor("t1"), historyGapFor("t2")]).toEqual(["reconnect", null]);
});

test("before the feed has loaded, no note is dropped: an empty first read is not an ended terminal (#2292)", async () => {
  noteHistoryGap("t1", "reconnect");
  noteHistoryGap("t2", "stream");
  await act(async () => root.render(<Workspace loaded={false} terminals={[]} />));
  expect([historyGapFor("t1"), historyGapFor("t2")]).toEqual(["reconnect", "stream"]);
});
