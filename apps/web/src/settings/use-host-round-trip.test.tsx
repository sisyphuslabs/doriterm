import type { HcConnection } from "@doriface/client";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useHostRoundTrip } from "./use-host-round-trip.ts";

// bun test has no DOM: React's client renderer reads `window` and a container. These stand in for exactly what is
// read, and are taken away after each test.
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

const connectionAnsweredBy = () => {
  const pending: (() => void)[] = [];
  const connection = {
    call: () => new Promise<void>((resolve) => void pending.push(resolve)),
  } as unknown as HcConnection;
  const answer = (): void => {
    for (const reply of pending.splice(0)) reply();
  };
  return { connection, answer };
};

const shown: (number | undefined)[] = [];
function Probe({ connection }: { readonly connection: HcConnection | null }) {
  shown.push(useHostRoundTrip(connection));
  return null;
}

test("a replaced connection shows no round trip until the new connection has answered", async () => {
  shown.length = 0;
  const first = connectionAnsweredBy();
  await act(async () => root.render(<Probe connection={first.connection} />));
  await act(async () => first.answer());
  expect(shown.at(-1)).toBeNumber();

  const second = connectionAnsweredBy();
  await act(async () => root.render(<Probe connection={second.connection} />));
  expect(shown.at(-1)).toBeUndefined();

  await act(async () => second.answer());
  expect(shown.at(-1)).toBeNumber();
});

test("a connection that pauses and comes back shows no round trip until it has answered again", async () => {
  shown.length = 0;
  const live = connectionAnsweredBy();
  await act(async () => root.render(<Probe connection={live.connection} />));
  await act(async () => live.answer());
  expect(shown.at(-1)).toBeNumber();

  await act(async () => root.render(<Probe connection={null} />));
  await act(async () => root.render(<Probe connection={live.connection} />));
  expect(shown.at(-1)).toBeUndefined();

  await act(async () => live.answer());
  expect(shown.at(-1)).toBeNumber();
});

test("a disconnected machine shows no round trip, not the last one measured", async () => {
  shown.length = 0;
  const live = connectionAnsweredBy();
  await act(async () => root.render(<Probe connection={live.connection} />));
  await act(async () => live.answer());
  expect(shown.at(-1)).toBeNumber();

  await act(async () => root.render(<Probe connection={null} />));
  expect(shown.at(-1)).toBeUndefined();
});
