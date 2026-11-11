import { afterEach, beforeEach, expect, test } from "bun:test";
import type { HcConnection } from "@doriface/client";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { type JoinOffer, useJoinOffer } from "./join-command.ts";

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
  for (const key of ["IS_REACT_ACT_ENVIRONMENT", "window", "document"]) Reflect.deleteProperty(globalThis, key);
});

/** The host's offer document, shared by every connection to it, and the requests written to it. */
const host = { value: null as unknown, version: 0, requests: [] as string[] };

/** A connection to `host` whose feed sends nothing; `closed` marks one that dropped. */
const connectionTo = (): HcConnection & { closed: boolean } => {
  const feed = { onSnapshot: () => () => {}, onEvent: () => () => {}, onClose: () => () => {}, close: () => {} };
  const connection = {
    closed: false,
    subscribe: async () => feed,
    call: async (method: string, params: { value?: { request: string } }) => {
      if (method === "doc.get") return { value: host.value, version: host.version };
      host.requests.push(params.value?.request ?? "");
      host.value = params.value;
      host.version += 1;
      return { version: host.version };
    },
  };
  // The fake answers the two calls the dialog makes, which the generic call signature cannot express.
  return connection as never;
};

let shown: JoinOffer = { phase: "asking" };
function Dialog({ connection }: { readonly connection: HcConnection }) {
  shown = useJoinOffer(connection, true);
  return null;
}

test("a join the host accepted on a dropped connection shows as joined on the next one, with no new request (#1780)", async () => {
  const first = connectionTo();
  await act(async () => root.render(<Dialog connection={first} />));
  expect(host.requests).toHaveLength(1);
  const request = host.requests[0] ?? "";

  // The connection drops; meanwhile the host makes the offer and the machine joins with it.
  first.closed = true;
  host.value = { request, joined: { name: "joiner", hostId: "h2" } };
  host.version += 1;
  await act(async () => root.render(<Dialog connection={connectionTo()} />));

  expect(shown).toEqual({ phase: "joined", name: "joiner" });
  expect(host.requests).toEqual([request]);
});
