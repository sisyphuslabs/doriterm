import type { HcEvent } from "@doriface/protocol";
import { expect, test } from "bun:test";
import { terminalUri } from "./subscriptions.ts";
import { SUB, session } from "./subscriptions.test-support.ts";

const statusEvent = (terminal: string, seq: number): HcEvent => ({
  type: "title",
  seq,
  terminal,
  data: { title: "vim" },
});

test("listen acknowledges first, sends only what was asked, and a missed stretch marks everything changed", async () => {
  const s = session();
  const acked = s.next();
  s.request(7, "subscriptions/listen", {
    notifications: {
      resourceSubscriptions: [terminalUri("t1"), "file:///x"],
      resourcesListChanged: true,
      toolsListChanged: true,
    },
  });
  await acked;
  expect(s.sent[0]).toEqual({
    jsonrpc: "2.0",
    method: "notifications/subscriptions/acknowledged",
    params: {
      notifications: { resourceSubscriptions: ["doriterm://terminal/t1"], resourcesListChanged: true },
      _meta: { [SUB]: 7 },
    },
  });
  const feed = s.feeds[0];
  if (feed === undefined) throw new Error("no feed was opened");
  feed.emit(statusEvent("t2", 1));
  feed.emit(statusEvent("t1", 2));
  feed.emit({ type: "created", seq: 3, terminal: "t3", data: { address: "t3" } as never });
  feed.missed();
  expect(
    s.sent.slice(1).map((message) => [message["method"], Reflect.get(Object(message["params"]), "uri") ?? null]),
  ).toEqual([
    ["notifications/resources/updated", "doriterm://terminal/t1"],
    ["notifications/resources/list_changed", null],
    ["notifications/resources/list_changed", null],
    ["notifications/resources/updated", "doriterm://terminal/t1"],
  ]);
  expect(
    s.sent.every(
      (message) =>
        message["method"] === undefined || Reflect.get(Object(Object(message["params"])["_meta"]), SUB) === 7,
    ),
  ).toBe(true);
});

test("events/stream: active first, events with the hc payload, heartbeats, and a missed stretch said as truncated", async () => {
  const s = session();
  const active = s.next();
  s.request(3, "events/stream", {
    name: "terminal.changed",
    arguments: { labels: { team: "a" } },
    cursor: "old",
    heartbeatMs: 1,
  });
  await active;
  expect(s.filters).toEqual([{ labels: { team: "a" } }]);
  expect(s.sent[0]).toMatchObject({
    method: "notifications/events/active",
    params: { cursor: null, truncated: true, heartbeatMs: 5000, _meta: { [SUB]: 3 } },
  });
  s.feeds[0]?.emit({
    type: "finished",
    seq: 4,
    terminal: "t7",
    machine: "box",
    data: { reason: "exited", exit_code: 0, signal: null, finished_ms: 1 },
  });
  s.beats[0]?.();
  s.feeds[0]?.missed();
  expect(s.sent[1]).toMatchObject({
    method: "notifications/events/event",
    params: {
      eventId: "box:4",
      name: "terminal.changed",
      cursor: null,
      data: { type: "finished", terminal: "box/t7", data: { exit_code: 0 } },
    },
  });
  expect(s.sent[2]).toMatchObject({
    method: "notifications/events/heartbeat",
    params: { cursor: null, _meta: { [SUB]: 3 } },
  });
  expect(s.sent[3]).toMatchObject({ method: "notifications/events/active", params: { truncated: true } });
});

test("a stream asked for an unknown event or bad arguments is refused before any feed opens", () => {
  const s = session();
  s.request(1, "events/stream", { name: "email.received" });
  s.request(2, "events/stream", { name: "terminal.changed", arguments: { labels: { team: 3 } } });
  s.request(3, "events/stream", { name: "terminal.changed", arguments: [] });
  expect(s.sent.map((message) => Reflect.get(Object(message["error"]), "code"))).toEqual([-32023, -32602, -32602]);
  expect(s.feeds).toHaveLength(0);
});

test("cancelling closes the hc feed and the heartbeat, and sends nothing more", async () => {
  const s = session();
  const active = s.next();
  s.request(4, "events/stream", { name: "terminal.changed" });
  await active;
  s.write({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 4 } });
  await Promise.resolve();
  expect(s.feeds[0]?.closedBy()).toBe("detached");
  s.feeds[0]?.emit(statusEvent("t1", 1));
  await Promise.resolve();
  expect(s.sent).toHaveLength(1);
  expect(s.stopped()).toBe(1);
});

test("the session ending closes every subscription's feed", async () => {
  const s = session();
  const acked = s.next(2);
  s.request(1, "subscriptions/listen", { notifications: { resourcesListChanged: true } });
  s.request(2, "events/stream", { name: "terminal.changed" });
  await acked;
  s.endSession();
  await Promise.resolve();
  expect(s.feeds.map((feed) => feed.closedBy())).toEqual(["detached", "detached"]);
});

test("a feed the core closes ends the subscription with its empty final response", async () => {
  const s = session();
  const acked = s.next();
  s.request(5, "subscriptions/listen", { notifications: { resourcesListChanged: true } });
  await acked;
  const done = s.next();
  s.feeds[0]?.endByCore();
  await done;
  expect(s.sent.at(-1)).toEqual({ jsonrpc: "2.0", id: 5, result: { resultType: "complete", _meta: { [SUB]: 5 } } });
});
