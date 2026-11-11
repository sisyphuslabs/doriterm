import { HcConnectionClosedError, HcHandshakeTimeoutError, HcProtocolError, HcTimeoutError } from "@doriface/client";
import { SecureLinkError } from "@doriface/crypto";
import { HcRpcError } from "@doriface/protocol";
import { RelayCloseError } from "@doriface/relay-client";
import { LinkCloseError } from "../connection/ws-link.ts";
import { afterEach, expect, jest, test } from "bun:test";
import { AttachRecovery, TerminalStreamLostError, transientAttachFailure } from "./attach-recovery.ts";

const rpc = (kind: string, message = kind): HcRpcError => new HcRpcError({ code: -32000, message, data: { kind } });
/** What a relayed stream's close carries when the relay socket drops: the secured link's error over the relay's. */
const relayBlip = (): SecureLinkError =>
  new SecureLinkError(1011, "relay socket closed with 1011: relay blip", {
    cause: new RelayCloseError(1011, "relay blip"),
  });
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
  [relayBlip(), true],
  [new SecureLinkError(1006, "link closed during the handshake"), true],
  [new SecureLinkError(4400, "crypto failure"), false],
  [new SecureLinkError(4401, "unknown device"), false],
  [new SecureLinkError(undefined, "closed"), false],
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

test("a relayed stream lost again and again re-attaches with no interaction, at most twice in its first second and three times in all (#2224)", () => {
  jest.useFakeTimers();
  let attaches = 0;
  const recovery = new AttachRecovery(
    () => {
      if (!recovery.begin()) return;
      attaches += 1;
      // Each re-attach opens, and the relay drops it again at once.
      recovery.succeeded();
      recovery.failed(relayBlip());
    },
    () => {},
  );
  recovery.begin();
  recovery.succeeded();
  recovery.failed(relayBlip());
  // Retries are due 250 and 500 ms (each +-20%) apart: two land within the first second, the third no sooner than 1.4 s.
  jest.advanceTimersByTime(1_000);
  expect(attaches).toBe(2);
  // A stream that never stays up for 10 s keeps one budget: three attempts, then Try again.
  jest.advanceTimersByTime(60_000);
  expect(attaches).toBe(3);
  expect(recovery.state).toMatchObject({ phase: "failed", transient: true });
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

test("an attempt that came due while the pane was hidden runs when it is shown, exempt from the interaction rate limit", () => {
  jest.useFakeTimers();
  let shown = false;
  let attaches = 0;
  const recovery = new AttachRecovery(
    () => {
      if (shown && recovery.begin()) attaches += 1;
    },
    () => {},
  );
  recovery.begin();
  recovery.failed(new TerminalStreamLostError());
  // Focus moving to the pane as its tab is chosen, before it is in view: the attempt finds nothing to attach.
  recovery.interact();
  expect(attaches).toBe(0);
  jest.advanceTimersByTime(10);
  shown = true;
  recovery.shown();
  expect(attaches).toBe(1);
  expect(recovery.state.phase).toBe("reconnecting");
  recovery.succeeded();
  expect(recovery.state.phase).toBe("idle");
});

test("with a retry pending, showing the pane and an interaction share the 250 ms limit in either order", () => {
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
  expect(recovery.interact()).toBe(true);
  expect(calls).toBe(1);
  // The fast failure left a 500 ms retry pending; showing the pane 100 ms later is inside the limit.
  jest.advanceTimersByTime(100);
  recovery.shown();
  expect(calls).toBe(1);
  // Past the limit, showing accelerates and starts a new limit window that input then respects.
  jest.advanceTimersByTime(160);
  recovery.shown();
  expect(calls).toBe(2);
  jest.advanceTimersByTime(100);
  expect(recovery.interact()).toBe(false);
  expect(calls).toBe(2);
  recovery.stop();
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
