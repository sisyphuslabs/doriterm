import type { HcEvent, HcSnapshot } from "@doriface/protocol";
import type { PushLink } from "../push/push-stream.ts";
import { type HcCaller, serveMcpLines } from "./serve.ts";

export const META = { "io.modelcontextprotocol/protocolVersion": "2026-07-28" };
export const SUB = "io.modelcontextprotocol/subscriptionId";
const enc = new TextEncoder();
const dec = new TextDecoder();

/** A feed the test drives: emit events, drop the subscriber behind, or close it as the core would. */
function fakeFeed() {
  const events: ((event: HcEvent) => void)[] = [];
  const snapshots: ((snapshot: HcSnapshot) => void)[] = [];
  const closes: ((close: { reason: string }) => void)[] = [];
  let closedBy: string | undefined;
  const end = (reason: string): void => {
    if (closedBy !== undefined) return;
    closedBy = reason;
    for (const listener of closes) listener({ reason });
  };
  return {
    feed: {
      snapshot: { seq: 0, terminals: [] },
      onEvent: (listener: (event: HcEvent) => void) => events.push(listener),
      onSnapshot: (listener: (snapshot: HcSnapshot) => void) => snapshots.push(listener),
      onClose: (listener: (close: { reason: string }) => void) => closes.push(listener),
      close: () => end("detached"),
    },
    // A closed feed delivers nothing more, as an EventFeed does.
    emit: (event: HcEvent) => closedBy === undefined && events.forEach((listener) => listener(event)),
    missed: () => closedBy === undefined && snapshots.forEach((listener) => listener({ seq: 9, terminals: [] })),
    endByCore: () => end("closed_by_core"),
    closedBy: () => closedBy,
  };
}

export function session() {
  const sent: Record<string, unknown>[] = [];
  const waiters: (() => void)[] = [];
  let onData: ((bytes: Uint8Array) => unknown) | undefined;
  let onLinkClose: (() => void) | undefined;
  const link: PushLink = {
    send: (bytes) => {
      sent.push(JSON.parse(dec.decode(bytes)));
      waiters.shift()?.();
    },
    onData: (handler) => {
      onData = handler;
    },
    onClose: (handler) => {
      onLinkClose = handler;
    },
    close: () => {},
  };
  const feeds: ReturnType<typeof fakeFeed>[] = [];
  const filters: object[] = [];
  const beats: (() => void)[] = [];
  let stopped = 0;
  const core: HcCaller = {
    callByName: async (method) =>
      method === "terminal.list"
        ? { terminals: [{ address: "t1", name: "build" }, { address: "box/t7" }] }
        : { text: "$ ok" },
    subscribe: async (filter) => {
      filters.push(filter);
      const fake = fakeFeed();
      feeds.push(fake);
      return fake.feed;
    },
    onClose: () => {},
    close: () => {},
  };
  serveMcpLines(link, {
    hostVersion: "0.0.0-test",
    openHc: async () => core,
    every: (_ms, beat) => {
      beats.push(beat);
      return () => {
        stopped += 1;
      };
    },
  });
  const write = (message: object): void => {
    onData?.(enc.encode(`${JSON.stringify(message)}\n`));
  };
  const request = (id: number, method: string, params: object = {}) =>
    write({ jsonrpc: "2.0", id, method, params: { _meta: META, ...params } });
  const next = (count = 1): Promise<void> =>
    new Promise((resolve) => {
      let left = count;
      const one = (): void => (--left === 0 ? resolve() : void waiters.push(one));
      waiters.push(one);
    });
  return {
    sent,
    write,
    request,
    next,
    feeds,
    filters,
    beats,
    stopped: () => stopped,
    endSession: () => onLinkClose?.(),
  };
}
