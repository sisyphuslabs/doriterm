import { describe, expect, test } from "bun:test";
import {
  FrameKind,
  readCredit,
  type Frame,
  type HcEvent,
  type HcSnapshot,
  type JsonRpcNotification,
} from "@doriface/protocol";
import { HcConnection, type SubscribeOptions } from "./connection.ts";
import { HcProtocolError } from "./errors.ts";
import type { EventFeed, FeedClose } from "./event-feed.ts";
import { FakeCore, refusingLink } from "./testing/fake-core.ts";
import { bytes, FINISHED_EVENT, HELLO_REPLY_LINE, SIZE_EVENT, SUBSCRIBE_REPLY, withId } from "./testing/fixtures.ts";

const CHANNEL = 1;
const next = <T>(register: (resolve: (value: T) => void) => void): Promise<T> =>
  new Promise((resolve) => register(resolve));
const event = (seq: number, type: string, data: string) =>
  `{"jsonrpc":"2.0","method":"event","params":{"data":${data},"seq":${seq},"terminal":"t1","type":"${type}"}}\n`;

async function subscribed(options: SubscribeOptions = { heartbeatTimeoutMs: 0 }) {
  const core = new FakeCore();
  const opening = HcConnection.open(core.client);
  await core.waitHello();
  core.push(`${HELLO_REPLY_LINE}\n`);
  const subscribing = (await opening).subscribe({}, options);
  const request = await core.waitRequest("events.subscribe");
  core.pushFrame(0, 0, withId(SUBSCRIBE_REPLY, Number(request.id)));
  const feed: EventFeed = await subscribing;
  return { core, feed, connection: await opening };
}

function collect(feed: EventFeed, count: number): Promise<HcEvent[]> {
  const events: HcEvent[] = [];
  return next((resolve) =>
    feed.onEvent((received) => {
      events.push(received);
      if (events.length === count) resolve(events);
    }),
  );
}

describe("EventFeed", () => {
  test("starts from the snapshot and delivers split events before returning their combined credit", async () => {
    const { core, feed } = await subscribed();
    expect([feed.channel, feed.snapshot.seq, feed.snapshot.terminals.map((t) => t.address)]).toEqual([
      CHANNEL,
      2,
      ["t1"],
    ]);
    const events = collect(feed, 2);
    const stream = bytes(SIZE_EVENT + FINISHED_EVENT);
    core.pushFrame(CHANNEL, FrameKind.Data, stream.subarray(0, 50));
    core.pushFrame(CHANNEL, FrameKind.Data, stream.subarray(50));
    const received = await events;
    expect(received.map((e) => [e.seq, e.type])).toEqual([
      [3, "size"],
      [5, "finished"],
    ]);
    const credit = await core.waitFrame((f) => f.channel === CHANNEL && f.kind === FrameKind.Credit);
    expect(readCredit(credit.payload)).toBe(stream.byteLength);
    expect(feed.seq).toBe(5);
  });

  test("drops events at or below the snapshot seq and restarts from a missed snapshot", async () => {
    const { core, feed } = await subscribed();
    const snapshots: HcSnapshot[] = [];
    feed.onSnapshot((snapshot) => snapshots.push(snapshot));
    const events = collect(feed, 2);
    core.pushFrame(
      CHANNEL,
      FrameKind.Data,
      event(2, "title", '{"title":"stale"}') +
        event(3, "title", '{"title":"fresh"}') +
        '{"jsonrpc":"2.0","method":"missed","params":{"seq":10,"terminals":[]}}\n' +
        event(9, "title", '{"title":"before snapshot"}') +
        event(11, "title", '{"title":"after snapshot"}'),
    );
    const received = await events;
    expect(received.map((e) => (e.type === "title" ? e.data.title : e.type))).toEqual(["fresh", "after snapshot"]);
    expect(snapshots).toEqual([{ seq: 10, terminals: [] }]);
    expect(feed.snapshot).toEqual({ seq: 10, terminals: [] });
  });

  test("returns no credit until the first event listener takes the queued events", async () => {
    const { core, feed, connection } = await subscribed();
    const dispatched = next<Frame>((resolve) => connection.raw.onFrame(resolve));
    const line = event(3, "title", '{"title":"queued"}');
    core.pushFrame(CHANNEL, FrameKind.Data, line);
    await dispatched;
    connection.raw.send(CHANNEL, FrameKind.Focus, new Uint8Array([0]));
    await core.waitFrame((f) => f.channel === CHANNEL && f.kind === FrameKind.Focus);
    expect(core.frames.some((f) => f.channel === CHANNEL && f.kind === FrameKind.Credit)).toBe(false);
    const events = collect(feed, 1);
    const credit = await core.waitFrame((f) => f.channel === CHANNEL && f.kind === FrameKind.Credit);
    expect(readCredit(credit.payload)).toBe(bytes(line).byteLength);
    expect((await events).map((e) => e.seq)).toEqual([3]);
  });

  test("stops reading a frame once a listener closed the feed", async () => {
    const { core, feed } = await subscribed();
    const seen: number[] = [];
    const closed = next<FeedClose>((resolve) => feed.onClose(resolve));
    feed.onEvent((received) => {
      seen.push(received.seq);
      feed.close();
    });
    core.pushFrame(CHANNEL, FrameKind.Data, event(3, "title", '{"title":"a"}') + event(4, "title", '{"title":"b"}'));
    expect(await closed).toEqual({ reason: "detached" });
    expect(seen).toEqual([3]);
  });

  test("stays open while heartbeats keep arriving", async () => {
    const { core, feed } = await subscribed({ heartbeatTimeoutMs: 200 });
    const beats = Array.from({ length: 8 }, (_, index) => index);
    for (const seq of beats) {
      core.pushFrame(CHANNEL, FrameKind.Data, `{"jsonrpc":"2.0","method":"heartbeat","params":{"seq":${seq}}}\n`);
      // oxlint-disable-next-line no-await-in-loop -- heartbeats must be spaced in time; time is the behavior under test
      await Bun.sleep(40);
    }
    expect(feed.closed).toBe(false);
    expect(await next<FeedClose>((resolve) => feed.onClose(resolve))).toEqual({ reason: "heartbeat_timeout" });
  });

  test("rejects a subscribe reply without a snapshot and closes its channel", async () => {
    const core = new FakeCore();
    const opening = HcConnection.open(core.client);
    await core.waitHello();
    core.push(`${HELLO_REPLY_LINE}\n`);
    const subscribing = (await opening).subscribe();
    const request = await core.waitRequest("events.subscribe");
    core.pushFrame(0, 0, `{"id":${request.id},"jsonrpc":"2.0","result":{"channel":1,"seq":"late","terminals":[]}}`);
    await expect(subscribing).rejects.toThrow(HcProtocolError);
    expect((await core.waitFrame((f) => f.channel === CHANNEL)).kind).toBe(FrameKind.Close);
  });

  test("passes notifications from a newer core to onUnknown", async () => {
    const { core, feed } = await subscribed();
    const unknown = next<JsonRpcNotification>((resolve) => feed.onUnknown(resolve));
    feed.onEvent(() => {});
    core.pushFrame(CHANNEL, FrameKind.Data, '{"jsonrpc":"2.0","method":"rewound","params":{"seq":4}}\n');
    expect((await unknown).method).toBe("rewound");
  });

  test("closes after heartbeat silence and tells the core", async () => {
    const { core, feed } = await subscribed({ heartbeatTimeoutMs: 30 });
    const closed = next<FeedClose>((resolve) => feed.onClose(resolve));
    expect(await closed).toEqual({ reason: "heartbeat_timeout" });
    const close = await core.waitFrame((f) => f.channel === CHANNEL && f.kind === FrameKind.Close);
    expect(close.payload.byteLength).toBe(0);
  });

  test("ends on a malformed line, a core CLOSE, a local close and a dropped link", async () => {
    const malformed = await subscribed();
    const protocol = next<FeedClose>((resolve) => malformed.feed.onClose(resolve));
    malformed.core.pushFrame(CHANNEL, FrameKind.Data, '{"jsonrpc":"2.0","id":1,"result":{}}\n');
    expect((await protocol).reason).toBe("protocol_error");

    const byCore = await subscribed();
    const coreClosed = next<FeedClose>((resolve) => byCore.feed.onClose(resolve));
    byCore.core.pushFrame(CHANNEL, FrameKind.Close);
    expect(await coreClosed).toEqual({ reason: "closed_by_core" });

    const local = await subscribed();
    local.feed.close();
    expect(local.feed.closed).toBe(true);
    await local.core.waitFrame((f) => f.channel === CHANNEL && f.kind === FrameKind.Close);

    const dropped = await subscribed();
    const linkGone = next<FeedClose>((resolve) => dropped.feed.onClose(resolve));
    dropped.core.hangUp();
    expect((await linkGone).reason).toBe("connection_closed");
  });

  test("closing the feed once its socket went away (sends throw, no close yet) does not throw, and the connection ends (#403)", async () => {
    const core = new FakeCore();
    const { link, refuse } = refusingLink(core);
    const opening = HcConnection.open(link);
    await core.waitHello();
    core.push(`${HELLO_REPLY_LINE}\n`);
    const connection = await opening;
    const subscribing = connection.subscribe({}, { heartbeatTimeoutMs: 0 });
    const request = await core.waitRequest("events.subscribe");
    core.pushFrame(0, 0, withId(SUBSCRIBE_REPLY, Number(request.id)));
    const feed = await subscribing;
    refuse();
    expect(() => feed.close()).not.toThrow();
    expect(connection.closed).toBe(true);
  });
});
