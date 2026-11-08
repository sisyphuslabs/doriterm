import { afterEach, expect, jest, test } from "bun:test";
import { type HcConnection, HcTimeoutError } from "@doriface/client";
import { DEFAULT_RELAY_URL, DEFAULT_SETTINGS } from "../connection/settings.ts";
import { UnprovenLinks } from "../connection/wake.ts";
import { HeldInput, type InputSink } from "./held-input.ts";
import type { TerminalInput } from "./terminal-view-props.ts";

// store.ts builds the app's store from localStorage as it loads; bun has none, so an empty one stands in for that load.
Object.assign(globalThis, { localStorage: { getItem: () => null, setItem: () => undefined } });
const { ConnectionStore } = await import("../connection/store.ts");
Reflect.deleteProperty(globalThis, "localStorage");

afterEach(() => jest.useRealTimers());

/** A stream that records what it took, or refuses every write once `refuseAfter` writes have gone through. */
function stream(refuseAfter = Infinity): InputSink & { readonly took: TerminalInput[] } {
  const took: TerminalInput[] = [];
  return {
    took,
    write: (data) => {
      if (took.length >= refuseAfter) return false;
      took.push(data);
      return true;
    },
  };
}

const link = {} as HcConnection;

function input(sink: InputSink | null, links = new UnprovenLinks()) {
  const held = new HeldInput(
    links,
    () => link,
    () => sink,
  );
  return { held, links, unwatch: held.watch() };
}

test("input typed while a wake proves the link waits, then reaches the same stream once and in order", () => {
  const sink = stream();
  const { held, links } = input(sink);
  links.start(link);
  held.send("a");
  held.send("b");
  held.send(new Uint8Array([0x0d]));
  expect(sink.took).toEqual([]);

  links.settle(link, true);
  expect(sink.took).toEqual(["a", "b", new Uint8Array([0x0d])]);
  expect(held.pending).toEqual([]);
  // Nothing is written twice: a later flush or a second answer has nothing left to send.
  held.flush();
  links.settle(link, true);
  expect(sink.took).toEqual(["a", "b", new Uint8Array([0x0d])]);
});

test("input on a proven link is written at once and nothing waits", () => {
  const sink = stream();
  const { held } = input(sink);
  held.send("a");
  expect(sink.took).toEqual(["a"]);
  expect(held.pending).toEqual([]);
});

test("a link that never proves itself gets none of what waited: it all goes to the next stream, once", () => {
  let sink: InputSink & { readonly took: TerminalInput[] } = stream();
  const old = sink;
  const links = new UnprovenLinks();
  const held = new HeldInput(
    links,
    () => link,
    () => sink,
  );
  held.watch();
  links.start(link);
  held.send("a");
  held.send("b");
  links.settle(link, false);
  expect(old.took).toEqual([]);
  expect(held.pending).toEqual(["a", "b"]);

  // The reattach takes what waited (use-terminal-attach.ts), and later input follows it on the new stream.
  sink = stream();
  for (const data of held.pending.splice(0)) sink.write(data);
  held.send("c");
  expect(sink.took).toEqual(["a", "b", "c"]);
  expect(old.took).toEqual([]);
});

test("a stream that refuses a write while what waited is flushed keeps the rest, in order, for the next one", () => {
  let sink: InputSink & { readonly took: TerminalInput[] } = stream(1);
  const first = sink;
  const links = new UnprovenLinks();
  const held = new HeldInput(
    links,
    () => link,
    () => sink,
  );
  held.watch();
  links.start(link);
  for (const data of ["a", "b", "c"]) held.send(data);
  links.settle(link, true);
  expect(first.took).toEqual(["a"]);
  expect(held.pending).toEqual(["b", "c"]);
  // Input typed after the refusal queues behind what still waits, so nothing overtakes it.
  held.send("d");
  expect(held.pending).toEqual(["b", "c", "d"]);

  sink = stream();
  held.flush();
  expect(sink.took).toEqual(["b", "c", "d"]);
});

test("another connection's answer releases nothing here", () => {
  const sink = stream();
  const { held, links } = input(sink);
  const other = {} as HcConnection;
  links.start(link);
  links.start(other);
  held.send("a");
  links.settle(other, true);
  expect(sink.took).toEqual([]);
});

test("a view that stopped watching is not written to by a later answer", () => {
  const sink = stream();
  const { held, links, unwatch } = input(sink);
  links.start(link);
  held.send("a");
  unwatch();
  links.settle(link, true);
  expect(sink.took).toEqual([]);
});

/** An open connection whose one call is answered when the spec says, or ends as the client ends it at its deadline. */
function answeringCore() {
  const answers: (() => void)[] = [];
  const listeners: ((error?: Error) => void)[] = [];
  let closed = false;
  const connection = {
    hello: { core: { id: "c0re", name: "" } },
    get closed() {
      return closed;
    },
    onClose: (listener: (error?: Error) => void) => (listeners.push(listener), () => undefined),
    close: () => {
      if (closed) return;
      closed = true;
      for (const listener of listeners) listener(undefined);
    },
    call: (method: string, _params: unknown, options: { readonly timeoutMs?: number } = {}) =>
      new Promise((resolve, reject) => {
        answers.push(() => resolve([]));
        const after = options.timeoutMs ?? 0;
        setTimeout(() => reject(new HcTimeoutError(method, after)), after);
      }),
  };
  return { connection: connection as unknown as HcConnection, answer: () => answers.shift()?.() };
}

const RELAY = { ...DEFAULT_SETTINGS, mode: "relay" as const, relayUrl: DEFAULT_RELAY_URL, hostId: "h", hostKey: "k" };

async function openStore(links: UnprovenLinks) {
  const core = answeringCore();
  const store = new ConnectionStore(
    RELAY,
    () => Promise.resolve({ connection: core.connection, path: "relay" }),
    undefined,
    {
      links,
    },
  );
  store.start();
  await Promise.resolve();
  await Promise.resolve();
  expect(store.state.phase).toBe("open");
  return { core, store };
}

async function turns(count = 5): Promise<void> {
  if (count === 0) return;
  await Promise.resolve();
  await turns(count - 1);
}

test("keys typed after a wake reach the stream once the core answers the wake's check, and only then (#1370)", async () => {
  jest.useFakeTimers();
  const links = new UnprovenLinks();
  const { core, store } = await openStore(links);
  const sink = stream();
  const held = new HeldInput(
    links,
    () => core.connection,
    () => sink,
  );
  held.watch();

  store.retryNow();
  for (const key of ["a", "b", "c"]) held.send(key);
  expect(sink.took).toEqual([]);

  core.answer();
  await turns();
  expect(sink.took).toEqual(["a", "b", "c"]);
  jest.advanceTimersByTime(30_000);
  await turns();
  expect(sink.took).toEqual(["a", "b", "c"]);
  store.stop();
});

test("keys typed with no wake in progress are written as they are typed (#1370)", async () => {
  jest.useFakeTimers();
  const links = new UnprovenLinks();
  const { core, store } = await openStore(links);
  const sink = stream();
  const held = new HeldInput(
    links,
    () => core.connection,
    () => sink,
  );
  held.watch();

  held.send("a");
  expect(sink.took).toEqual(["a"]);
  store.retryNow();
  core.answer();
  await turns();
  held.send("b");
  expect(sink.took).toEqual(["a", "b"]);
  store.stop();
});
