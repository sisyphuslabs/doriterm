import { describe, expect, test } from "bun:test";
import { HcRpcError } from "@doriface/protocol";
import { HcConnection } from "./connection.ts";
import { HcTimeoutError } from "./errors.ts";
import { RttEstimator } from "./rtt.ts";
import { FakeCore } from "./testing/fake-core.ts";
import { HELLO_REPLY_LINE, ATTACH_REPLY, STATUS_REPLY, withId } from "./testing/fixtures.ts";

/** A clock the test moves by hand, so a sample's round trip is exactly what the test says it is. */
function fakeClock(): { readonly now: () => number; readonly advance: (ms: number) => void } {
  let at = 0;
  return {
    now: () => at,
    advance: (ms) => {
      at += ms;
    },
  };
}

const WAIT_REPLY = '{"state":"idle"}';
async function opened(core: FakeCore, callTimeoutMs?: number): Promise<HcConnection> {
  const connection = HcConnection.open(core.client, callTimeoutMs === undefined ? {} : { callTimeoutMs });
  await core.waitHello();
  core.push(`${HELLO_REPLY_LINE}\n`);
  return connection;
}

describe("RttEstimator", () => {
  test("has no estimate until the first call is answered", () => {
    const estimator = new RttEstimator(fakeClock().now);
    expect(estimator.estimate).toBeUndefined();
  });

  test("follows RFC 6298's EWMA: the first sample is srtt with half of it as rttvar", () => {
    const clock = fakeClock();
    const estimator = new RttEstimator(clock.now);
    const sentAt = estimator.mark();
    clock.advance(100);
    estimator.sample(sentAt);
    expect(estimator.estimate).toEqual({ srtt: 100, rttvar: 50, samples: 1 });
  });

  test("smooths 100 then 300 into srtt 125 and rttvar 87.5, and varies against the previous srtt", () => {
    const clock = fakeClock();
    const estimator = new RttEstimator(clock.now);
    const measure = (ms: number): void => {
      const sentAt = estimator.mark();
      clock.advance(ms);
      estimator.sample(sentAt);
    };
    measure(100);
    measure(300);
    // srtt = 0.875 * 100 + 0.125 * 300 = 125; rttvar = 0.75 * 50 + 0.25 * |100 - 300| = 87.5.
    expect(estimator.estimate).toEqual({ srtt: 125, rttvar: 87.5, samples: 2 });
    measure(200);
    // rttvar varies against the srtt BEFORE this sample (125, not 134.375): 0.75 * 87.5 + 0.25 * |125 - 200| = 84.375.
    expect(estimator.estimate).toEqual({ srtt: 134.375, rttvar: 84.375, samples: 3 });
  });
});

describe("HcConnection.rtt", () => {
  test("is undefined before any call is answered", async () => {
    const connection = await opened(new FakeCore());
    expect(connection.rtt).toBeUndefined();
  });

  test("an answered call is one sample", async () => {
    const core = new FakeCore();
    const connection = await opened(core);
    const status = connection.call("server.status");
    const request = await core.waitRequest("server.status");
    core.pushFrame(0, 0, withId(STATUS_REPLY, Number(request.id)));
    await status;
    const rtt = connection.rtt;
    if (rtt === undefined) throw new Error("expected an estimate after one answered call");
    expect([rtt.samples, rtt.srtt]).toEqual([1, rtt.rttvar * 2]);
    expect(rtt.srtt).toBeGreaterThan(0);
  });

  test("a timed-out call never feeds it, and its late reply is not a sample either", async () => {
    const core = new FakeCore();
    const connection = await opened(core, 20);
    const status = connection.call("server.status");
    await expect(status).rejects.toThrow(HcTimeoutError);
    const timedOut = await core.waitRequest("server.status");
    expect(connection.rtt).toBeUndefined();
    core.pushFrame(0, 0, withId(STATUS_REPLY, Number(timedOut.id)));
    await core.waitFrame((f) => new TextDecoder().decode(f.payload).includes("$/cancelRequest"));
    const list = connection.call("terminal.list");
    const listRequest = await core.waitRequest("terminal.list");
    core.pushFrame(
      0,
      0,
      '{"id":' + String(listRequest.id) + ',"jsonrpc":"2.0","result":{"hidden_finished":0,"terminals":[]}}',
    );
    await list;
    expect(connection.rtt?.samples).toBe(1);
  });

  test("an aborted call never feeds it", async () => {
    const core = new FakeCore();
    const connection = await opened(core);
    const controller = new AbortController();
    const status = connection.call("server.status", {}, { signal: controller.signal });
    const request = await core.waitRequest("server.status");
    controller.abort(new Error("user left"));
    await expect(status).rejects.toThrow("user left");
    core.pushFrame(0, 0, withId(STATUS_REPLY, Number(request.id)));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(connection.rtt).toBeUndefined();
  });

  test("an error reply is an answer: the link proved itself, so it is a sample", async () => {
    const core = new FakeCore();
    const connection = await opened(core);
    const kill = connection.call("terminal.kill", { terminal: "t9" });
    const request = await core.waitRequest("terminal.kill");
    core.pushFrame(
      0,
      0,
      '{"id":' + String(request.id) + ',"jsonrpc":"2.0","error":{"code":-32000,"message":"no terminal t9"}}',
    );
    const error: unknown = await kill.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(HcRpcError);
    expect(connection.rtt?.samples).toBe(1);
  });

  test("a call that waits by design measures the program, not the link, so it never feeds it", async () => {
    const core = new FakeCore();
    const connection = await opened(core);
    const wait = connection.call("terminal.wait", { terminal: "t1" });
    const request = await core.waitRequest("terminal.wait");
    core.pushFrame(0, 0, '{"id":' + String(request.id) + ',"jsonrpc":"2.0","result":' + WAIT_REPLY + "}");
    await wait;
    expect(connection.rtt).toBeUndefined();
  });

  test("an attach is a sample like any other call", async () => {
    const core = new FakeCore();
    const connection = await opened(core);
    const attach = connection.attach({ terminal: "t1", cols: 80, rows: 24 });
    const request = await core.waitRequest("terminal.attach");
    core.pushFrame(0, 0, withId(ATTACH_REPLY, Number(request.id)));
    const stream = await attach;
    expect(connection.rtt?.samples).toBe(1);
    stream.close();
  });
});
