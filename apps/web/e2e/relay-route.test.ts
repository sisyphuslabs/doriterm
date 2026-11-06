import { expect, test } from "bun:test";
import { join } from "node:path";
import { startFakeRelayHost } from "./relay-route.ts";

const here = import.meta.dirname;

/** What a start failed with: these are about the message, and bun's `rejects` would only hand back the same error. */
async function failureOf(started: Promise<unknown>): Promise<string> {
  try {
    await started;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("the start did not fail");
}

/** Runs `body` with HC_BIN at `bin` and puts it back after, so a blocked start cannot change another test's hc. */
async function withHcBin<T>(bin: string, body: () => Promise<T>): Promise<T> {
  const before = process.env["HC_BIN"];
  process.env["HC_BIN"] = bin;
  try {
    return await body();
  } finally {
    if (before === undefined) delete process.env["HC_BIN"];
    else process.env["HC_BIN"] = before;
  }
}

test("a start blocked on hc fails inside the stage deadline, saying which stage it is in (#502)", async () => {
  const started = Date.now();
  // The deadline runs from the session report: the start is blocked on hc after it, so the deadline lands there however
  // long a loaded host takes to reach it (#692).
  const failure = await withHcBin(join(here, "fake-hc.ts"), () =>
    failureOf(startFakeRelayHost({ machine: true, stageDeadlineMs: 300, stageDeadlineFrom: "session" })),
  );
  expect(failure).toContain("did not finish the bridge within 300 ms");
  expect(failure).toMatch(/it is in session \(done: relay \d+ ms, pair lookup \d+ ms, session \d+ ms\)/);
  expect(Date.now() - started).toBeLessThan(8_000);
}, 10_000);
test("a start that dies fails at once with its exit, not with a timeout (#502)", async () => {
  const started = Date.now();
  const failure = await withHcBin(join(here, "no-such-hc"), () => failureOf(startFakeRelayHost({ machine: true })));
  expect(failure).toContain("exited (code 1)");
  expect(Date.now() - started).toBeLessThan(8_000);
}, 10_000);

test("a pairing link asked for long after the start gets its own deadline, not the start's (#502)", async () => {
  const host = await startFakeRelayHost({ machine: true, stageDeadlineMs: 1_500 });
  try {
    // The time between the start and this ask is the condition: a window left over from the startup would be spent.
    await Bun.sleep(1_800);
    expect(await host.pairingLink()).toContain("/pair#");
  } finally {
    await host.stop();
  }
}, 60_000);

test("a start that reports its stages resolves, and a pairing link comes back over the same channel", async () => {
  const host = await startFakeRelayHost({ machine: true });
  try {
    expect(await host.pairingLink()).toContain("/pair#");
  } finally {
    await host.stop();
  }
}, 60_000);
