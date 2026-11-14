import { afterAll, afterEach, describe, expect, setSystemTime, test } from "bun:test";
import type { ServerWebSocket } from "bun";
import { generateSigningKey, ed25519Signer } from "./signer.ts";
import { Uplink, type UplinkState } from "./uplink.ts";

/** What the fake relay does with each attempt, in order: answer it and keep it, or end it before any challenge. */
type Step = "keep" | "drop-at-once";

let steps: Step[] = [];
const kept: ServerWebSocket<{ readonly step: Step }>[] = [];

const relay = Bun.serve<{ readonly step: Step }>({
  hostname: "127.0.0.1",
  port: 0,
  fetch: (request, server) =>
    server.upgrade(request, { data: { step: steps.shift() ?? "keep" } })
      ? undefined
      : new Response("upgrade", { status: 426 }),
  websocket: {
    open: (ws) => {
      if (ws.data.step === "drop-at-once") return ws.terminate();
      kept.push(ws);
      ws.send(new Uint8Array(32));
    },
    message: () => undefined,
  },
});
afterAll(() => relay.stop(true));

let uplink: Uplink | undefined;
afterEach(() => {
  uplink?.stop();
  uplink = undefined;
  steps = [];
  kept.length = 0;
  setSystemTime();
});

/** Starts an uplink; `until(states)` resolves once the states seen so far satisfy `done`. */
async function start(
  random: () => number,
): Promise<(done: (states: UplinkState[]) => boolean) => Promise<UplinkState[]>> {
  const states: UplinkState[] = [];
  const waiters = new Set<() => void>();
  uplink = await Uplink.start({
    relayUrl: `http://127.0.0.1:${relay.port}`,
    signer: ed25519Signer(generateSigningKey()),
    random,
    onSession: () => undefined,
    onState: (state) => {
      states.push(state);
      for (const check of waiters) check();
    },
  });
  return (done) =>
    new Promise((resolve) => {
      const check = (): void => {
        if (!done(states)) return;
        waiters.delete(check);
        resolve(states);
      };
      waiters.add(check);
      check();
    });
}

const waitings = (states: UplinkState[]): UplinkState[] => states.filter((state) => state.state === "waiting");

/** Ends the relay side of the one kept socket without a close frame, as a platform restart does: the host sees 1006. */
function restartRelay(): void {
  keptSocket().terminate();
}

function keptSocket(): ServerWebSocket<{ readonly step: Step }> {
  const ws = kept.shift();
  if (ws === undefined) throw new Error("no relay socket to end");
  return ws;
}

const retries = (states: UplinkState[]): number[] =>
  waitings(states).map((state) => (state.state === "waiting" ? state.retryInMs : -1));

/** A stable uplink: answered, then 30 s later by the clock the uplink reads. */
async function stableUplink(
  random: () => number,
): Promise<(done: (states: UplinkState[]) => boolean) => Promise<UplinkState[]>> {
  const until = await start(random);
  await until((states) => states.some((state) => state.state === "answered"));
  setSystemTime(new Date(Date.now() + 30_000));
  return until;
}

describe("the uplink's redial after the relay ends it (#2498)", () => {
  test("an uplink that had been up for 30 s redials within one backoff floor after a 1006, not after the first backoff step", async () => {
    const until = await stableUplink(() => 1);
    restartRelay();
    const states = await until((seen) => waitings(seen).length === 1);
    expect(waitings(states)).toEqual([{ state: "waiting", code: 1006, reason: "", retryInMs: 249 }]);
  });

  test("hosts dropped in the same second spread their quick redials over the backoff floor instead of one tick", async () => {
    const until = await stableUplink(() => 0.2);
    restartRelay();
    expect(retries(await until((seen) => waitings(seen).length === 1))).toEqual([50]);
  });

  test("when the quick redial fails too, the next one waits the first backoff step, not a later one", async () => {
    const until = await stableUplink(() => 1);
    steps = ["drop-at-once"];
    restartRelay();
    expect(retries(await until((seen) => waitings(seen).length === 2))).toEqual([249, 500]);
  });

  test("a stable uplink the relay rate-limits (4429) waits the backoff, never a quick redial", async () => {
    const until = await stableUplink(() => 1);
    keptSocket().close(4429, "rate limited");
    const states = await until((seen) => waitings(seen).length === 1);
    expect(waitings(states)).toEqual([{ state: "waiting", code: 4429, reason: "rate limited", retryInMs: 500 }]);
  });

  test("the redial after a stable uplink drops is a reconnect (attempt 1), not a fresh start", async () => {
    const until = await stableUplink(() => 1);
    restartRelay();
    const states = await until((seen) => seen.filter((state) => state.state === "connecting").length === 2);
    expect(states.filter((state) => state.state === "connecting")).toEqual([
      { state: "connecting", attempt: 0 },
      { state: "connecting", attempt: 1 },
    ]);
  });

  test("an uplink that dropped within 30 s of its answer waits the backoff, so a flapping relay is not redialed hot", async () => {
    const until = await start(() => 1);
    await until((states) => states.some((state) => state.state === "answered"));
    restartRelay();
    const states = await until((seen) => waitings(seen).length === 1);
    expect(waitings(states)).toEqual([{ state: "waiting", code: 1006, reason: "", retryInMs: 500 }]);
  });
});
