import { afterEach, beforeEach, expect, jest, test } from "bun:test";
import type { HcConnection } from "@doriface/client";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { type JoinOffer, OFFER_ANSWER_MS, useJoinOffer } from "./join-command.ts";

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
  jest.useRealTimers();
  Object.assign(host, { value: null, version: 0, requests: [] });
  for (const key of ["IS_REACT_ACT_ENVIRONMENT", "window", "document"]) Reflect.deleteProperty(globalThis, key);
});

/** The host's offer document, shared by every connection to it, and the requests written to it. */
const host = { value: null as unknown, version: 0, requests: [] as string[] };

/** A connection to `host` whose feeds send nothing: `end` ends the open one as the core would, `failing` subscribes fail. */
type Fake = HcConnection & {
  closed: boolean;
  subscribes: number;
  failing: number;
  end: (reason: string) => void;
};
const connectionTo = (): Fake => {
  const ends: ((close: { reason: string }) => void)[] = [];
  const feed = {
    onSnapshot: () => () => {},
    onEvent: () => () => {},
    onClose: (listener: (close: { reason: string }) => void) => (ends.push(listener), () => {}),
    close: () => {},
  };
  const connection = {
    closed: false,
    subscribes: 0,
    failing: 0,
    end: (reason: string) => ends.splice(0).forEach((listener) => listener({ reason })),
    subscribe: async () => {
      connection.subscribes += 1;
      if (connection.failing > 0) {
        connection.failing -= 1;
        throw new Error("events.subscribe failed");
      }
      return feed;
    },
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

/** The host makes the offer for the dialog's request and the machine joins with it, while no feed is open. */
const joinMeanwhile = (): void => {
  host.value = { request: host.requests[0] ?? "", joined: { name: "joiner", hostId: "h2" } };
  host.version += 1;
};

test("a feed the core ends on a live connection is followed again and the offer read, so a join made meanwhile shows (#1780)", async () => {
  const connection = connectionTo();
  await act(async () => root.render(<Dialog connection={connection} />));
  joinMeanwhile();
  await act(async () => connection.end("closed_by_core"));
  expect(connection.subscribes).toBe(2);
  expect(shown).toEqual({ phase: "joined", name: "joiner" });
});

test("a subscribe that fails is tried again after a backoff, not dropped (#1780)", async () => {
  jest.useFakeTimers();
  const connection = connectionTo();
  await act(async () => root.render(<Dialog connection={connection} />));
  connection.failing = 1;
  joinMeanwhile();
  await act(async () => connection.end("protocol_error"));
  expect(connection.subscribes).toBe(2);
  await act(async () => jest.advanceTimersByTime(249));
  expect(connection.subscribes).toBe(2);
  await act(async () => jest.advanceTimersByTime(1));
  expect(connection.subscribes).toBe(3);
  expect(shown).toEqual({ phase: "joined", name: "joiner" });
});

test("a host that did not answer on the connection before is asked again on the new one, not shown as failed (#1780)", async () => {
  jest.useFakeTimers();
  const first = connectionTo();
  await act(async () => root.render(<Dialog connection={first} />));
  await act(async () => jest.advanceTimersByTime(OFFER_ANSWER_MS));
  expect(shown.phase).toBe("failed");
  first.closed = true;
  await act(async () => root.render(<Dialog connection={connectionTo()} />));
  expect(shown).toEqual({ phase: "asking" });
});
