import { describe, expect, test } from "bun:test";
import { HcConnection, type SubscribeOptions } from "./connection.ts";
import { HcLinkSilentError } from "./errors.ts";
import type { ByteLink } from "./link.ts";
import { FakeCore } from "./testing/fake-core.ts";
import { HELLO_REPLY_LINE, SUBSCRIBE_REPLY, withId } from "./testing/fixtures.ts";

const next = <T>(register: (resolve: (value: T) => void) => void): Promise<T> =>
  new Promise((resolve) => register(resolve));

async function subscribed(options: SubscribeOptions, lost?: (reason: Error) => boolean) {
  const core = new FakeCore();
  // The core's link is a class instance; spreading it loses its prototype, so the methods are bound by hand.
  const client = core.client;
  const link: ByteLink =
    lost === undefined
      ? client
      : {
          send: (bytes) => client.send(bytes),
          onData: (listener) => client.onData(listener),
          onClose: (listener) => client.onClose(listener),
          close: () => client.close(),
          lost,
        };
  const opening = HcConnection.open(link);
  await core.waitHello();
  core.push(`${HELLO_REPLY_LINE}\n`);
  const connection = await opening;
  const subscribing = connection.subscribe({}, options);
  const request = await core.waitRequest("events.subscribe");
  core.pushFrame(0, 0, withId(SUBSCRIBE_REPLY, Number(request.id)));
  return { core, connection, feed: await subscribing };
}

describe("a silent link", () => {
  test("closes the connection with HcLinkSilentError once the feed's heartbeats stop", async () => {
    const { connection } = await subscribed({ heartbeatTimeoutMs: 30 });
    const closed = next<Error | undefined>((resolve) => connection.onClose(resolve));
    const error = await closed;
    expect(error).toBeInstanceOf(HcLinkSilentError);
    expect(connection.closed).toBe(true);
  });

  test("a link that can carry the session on takes the loss: the connection and the feed stay open, and the silence is asked again", async () => {
    const losses: Error[] = [];
    // The second loss is what proves the silence is asked again; it is awaited, not given a fixed time to happen.
    const askedAgain = Promise.withResolvers<void>();
    const { core, connection, feed } = await subscribed({ heartbeatTimeoutMs: 30 }, (reason) => {
      losses.push(reason);
      if (losses.length === 2) askedAgain.resolve();
      return true;
    });
    const feedClosed: unknown[] = [];
    feed.onClose((info) => feedClosed.push(info));
    await askedAgain.promise;
    expect(losses[0]).toBeInstanceOf(HcLinkSilentError);
    expect(connection.closed).toBe(false);
    expect(feedClosed).toEqual([]);
    // The beats come back (the link resumed): the feed is as it was.
    core.pushFrame(feed.channel, 0, '{"jsonrpc":"2.0","method":"heartbeat","params":{"seq":2}}\n');
    expect(feedClosed).toEqual([]);
    connection.close();
  });

  test("a feed closed by its owner does not close the connection", async () => {
    const { connection, feed } = await subscribed({ heartbeatTimeoutMs: 30 });
    // The close it would cause happens inside feed.close(), and closing the feed stops its heartbeat timer.
    feed.close();
    expect(connection.closed).toBe(false);
    connection.close();
  });
});
