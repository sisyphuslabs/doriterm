import { HcConnectionClosedError, HcHandshakeTimeoutError, HcProtocolError, HcTimeoutError } from "@doriface/client";
import { HcRpcError } from "@doriface/protocol";
import { RelayCloseError } from "@doriface/relay-client";
import { LinkCloseError } from "../connection/ws-link.ts";
import { afterEach, expect, jest, test } from "bun:test";
import { AttachRecovery, TerminalStreamLostError, transientAttachFailure } from "./attach-recovery.ts";

const rpc = (kind: string, message = kind): HcRpcError => new HcRpcError({ code: -32000, message, data: { kind } });
afterEach(() => jest.useRealTimers());

test.each([
  [new HcConnectionClosedError(), true],
  [new HcTimeoutError("terminal.attach", 2_000), true],
  [new HcHandshakeTimeoutError(2_000), true],
  [new TerminalStreamLostError(), true],
  [new LinkCloseError(1011, "relay blip"), true],
  [new LinkCloseError(1006, ""), true],
  [new RelayCloseError(4404, "host offline"), true],
  [new RelayCloseError(4408, "deadline"), true],
  [new LinkCloseError(4401, "unknown device"), false],
  [new RelayCloseError(4403, "auth refused"), false],
  [new RelayCloseError(4402, "invalid frame"), false],
  [new LinkCloseError(1002, "invalid protocol"), false],
  [rpc("unavailable"), true],
  [rpc("internal", "machine rack is unreachable"), true],
  [rpc("unauthorized"), false],
  [rpc("invalid_request"), false],
  [rpc("not_found"), false],
  [new HcProtocolError("malformed reply"), false],
  [rpc("internal", "socket invalid"), false],
  [new Error("unknown failure"), false],
] as const)("classifies %s as transient=%s", (cause, expected) => {
  expect(transientAttachFailure(cause)).toBe(expected);
});

test("a transient failure gets three bounded, jittered retries and then stays failed", () => {
  jest.useFakeTimers();
  let calls = 0;
  const times: number[] = [];
  const recovery = new AttachRecovery(
    () => {
      if (!recovery.begin()) return;
      times.push(Date.now());
      calls += 1;
      recovery.failed(rpc("unavailable"));
    },
    () => {},
  );
  const started = Date.now();
  recovery.begin();
  recovery.failed(rpc("unavailable"));
  jest.advanceTimersByTime(199);
  expect(calls).toBe(0);
  jest.advanceTimersByTime(10_000);
  expect(calls).toBe(3);
  expect(recovery.state.phase).toBe("failed");
  let previous = started;
  for (const [index, time] of times.entries()) {
    const base = 250 * 2 ** index;
    expect(time - previous).toBeGreaterThanOrEqual(base * 0.8);
    expect(time - previous).toBeLessThanOrEqual(base * 1.2);
    previous = time;
  }
  jest.advanceTimersByTime(60_000);
  expect(calls).toBe(3);
});

test("interaction advances a waiting tick once, never overlaps the in-flight attach", () => {
  jest.useFakeTimers();
  let calls = 0;
  const recovery = new AttachRecovery(
    () => {
      if (recovery.begin()) calls += 1;
    },
    () => {},
  );
  recovery.begin();
  recovery.failed(rpc("unavailable"));
  recovery.interact();
  for (let event = 0; event < 60; event += 1) {
    recovery.interact();
    jest.advanceTimersByTime(16);
  }
  jest.advanceTimersByTime(60_000);
  expect(calls).toBe(1);
  recovery.succeeded();
  expect(recovery.state.phase).toBe("idle");
});

test("auth and stable missing targets do not retry on interaction, but allow an explicit retry", () => {
  jest.useFakeTimers();
  for (const kind of ["unauthorized", "not_found", "invalid_params"]) {
    let calls = 0;
    const recovery = new AttachRecovery(
      () => {
        if (recovery.begin()) calls += 1;
      },
      () => {},
    );
    recovery.begin();
    recovery.failed(rpc(kind));
    recovery.interact();
    jest.advanceTimersByTime(60_000);
    expect(calls).toBe(0);
    expect(recovery.state.phase).toBe("failed");
    recovery.manual();
    expect(calls).toBe(1);
    recovery.stop();
  }
});

test("leaving the pane cancels its queued retry", () => {
  jest.useFakeTimers();
  let calls = 0;
  const recovery = new AttachRecovery(
    () => {
      calls += 1;
    },
    () => {},
  );
  recovery.begin();
  recovery.failed(rpc("unavailable"));
  recovery.stop();
  jest.advanceTimersByTime(60_000);
  expect(calls).toBe(0);
});

test("60 interactions at 16 ms keep the budget and rate limit between fast failures", () => {
  jest.useFakeTimers();
  let calls = 0;
  const times: number[] = [];
  const recovery = new AttachRecovery(
    () => {
      if (!recovery.begin()) return;
      calls += 1;
      times.push(Date.now());
      recovery.failed(rpc("unavailable"));
    },
    () => {},
  );
  recovery.begin();
  recovery.failed(rpc("unavailable"));
  const admitted: boolean[] = [];
  for (let event = 0; event < 60; event += 1) {
    admitted.push(recovery.interact());
    jest.advanceTimersByTime(16);
  }
  expect(calls).toBe(3);
  expect(admitted.filter(Boolean)).toHaveLength(3);
  let previous: number | undefined;
  for (const time of times) {
    if (previous !== undefined) expect(time - previous).toBeGreaterThanOrEqual(250);
    previous = time;
  }
  expect(recovery.state.phase).toBe("failed");
  jest.advanceTimersByTime(1_001);
  recovery.interact();
  expect(calls).toBe(4);
  recovery.stop();
});

test("an exhausted episode permits only one fresh interaction cycle after quiet", () => {
  jest.useFakeTimers();
  let calls = 0;
  const recovery = new AttachRecovery(
    () => {
      if (!recovery.begin()) return;
      calls += 1;
      recovery.failed(rpc("unavailable"));
    },
    () => {},
  );
  recovery.begin();
  recovery.failed(rpc("unavailable"));
  jest.advanceTimersByTime(2_101);
  expect(calls).toBe(3);
  expect(recovery.interact()).toBe(true);
  jest.advanceTimersByTime(2_101);
  expect(calls).toBe(6);
  expect(recovery.interact()).toBe(false);
  jest.advanceTimersByTime(10_000);
  expect(calls).toBe(6);
  recovery.manual();
  expect(calls).toBe(7);
  recovery.stop();
});
