import { expect, test } from "bun:test";
import { connect } from "./connect.ts";
import { installShellForwarder } from "./direct-forward.test-support.ts";
import { DEFAULT_SETTINGS } from "./settings.ts";

const HOST_ID = "a".repeat(26);
const HOST_KEY = "a".repeat(43);
const deps = { loadDeviceKey: () => Promise.reject(new Error("this path never loads the device key")) };

/** A listener that accepts and never answers, so a WebSocket to it stays CONNECTING and counts nothing as opened. */
function neverAnswers(hooks: { readonly open?: () => void; readonly close?: () => void } = {}): {
  readonly port: number;
  readonly stop: () => void;
} {
  const server = Bun.listen<undefined>({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      data: () => undefined,
      open: () => hooks.open?.(),
      close: () => hooks.close?.(),
    },
  });
  return { port: server.port, stop: () => void server.stop(true) };
}

const settings = (relayPort: number, directPort?: number) => ({
  ...DEFAULT_SETTINGS,
  relayUrl: `ws://127.0.0.1:${relayPort}`,
  directUrl: directPort === undefined ? "" : `ws://127.0.0.1:${directPort}/v1/e2ee`,
  hostId: HOST_ID,
  hostKey: HOST_KEY,
});

test("a connect the caller abandons rejects at once and closes the relay socket it dialed", async () => {
  const cancelled = new AbortController();
  const closed = Promise.withResolvers<void>();
  let dialed = 0;
  const relay = neverAnswers({
    open: () => {
      dialed += 1;
      cancelled.abort(new Error("the person changed the settings"));
    },
    close: () => closed.resolve(),
  });
  try {
    const outcome = await Promise.race([
      connect(settings(relay.port), cancelled.signal, deps).then(
        () => "opened",
        (caught: unknown) => caught,
      ),
      Bun.sleep(2_000).then(() => "still dialing"),
    ]);
    expect(String(outcome)).toContain("the person changed the settings");
    expect(dialed).toBe(1);
    expect(await Promise.race([closed.promise.then(() => "closed"), Bun.sleep(2_000).then(() => "still open")])).toBe(
      "closed",
    );
  } finally {
    relay.stop();
  }
});

// Only the desktop shell races a direct leg first (#1381 §8); a browser goes to the relay at once. The direct path is
// off (#2070): the leg is tested with the switch on for this test alone.
test("in the desktop shell with the direct path on, an attempt abandoned during the direct leg does not dial the relay at all", async () => {
  const shell = installShellForwarder();
  const cancelled = new AbortController();
  const lan = neverAnswers({ open: () => cancelled.abort(new Error("the person changed the settings")) });
  let relayDials = 0;
  const relay = neverAnswers({
    open: () => {
      relayDials += 1;
    },
  });
  try {
    const outcome = await Promise.race([
      connect(settings(relay.port, lan.port), cancelled.signal, deps, { directPath: true }).then(
        () => "opened",
        (caught: unknown) => caught,
      ),
      Bun.sleep(2_000).then(() => "still dialing"),
    ]);
    expect(String(outcome)).toContain("the person changed the settings");
    expect(relayDials).toBe(0);
  } finally {
    shell.restore();
    lan.stop();
    relay.stop();
  }
});

test("an attempt deadline fails inside itself, and closes the relay socket it was dialing", async () => {
  const closed = Promise.withResolvers<void>();
  const relay = neverAnswers({ close: () => closed.resolve() });
  try {
    const started = performance.now();
    const outcome = await Promise.race([
      connect(settings(relay.port), undefined, deps, { deadlineMs: 150 }).then(
        () => "opened",
        (caught: unknown) => caught,
      ),
      Bun.sleep(2_000).then(() => "still dialing"),
    ]);
    expect(String(outcome)).toContain("no session within 150 ms");
    expect(performance.now() - started).toBeLessThan(1_500);
    expect(await Promise.race([closed.promise.then(() => "closed"), Bun.sleep(1_000).then(() => "still open")])).toBe(
      "closed",
    );
  } finally {
    relay.stop();
  }
});
