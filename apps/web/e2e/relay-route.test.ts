import { expect, test } from "bun:test";
import { join } from "node:path";
import { type DeadlineClock, startFakeRelayHost } from "./relay-route.ts";

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
test("a host whose hc is missing says so once and stops without spawning it again (#1538)", async () => {
  const missing = join(here, "no-such-hc");
  const proc = Bun.spawn(
    [process.execPath, join(here, "fake-relay-host.ts"), "http://127.0.0.1:1", "wss://relay.invalid", "--machine"],
    { env: { ...process.env, HC_BIN: missing }, stdin: "ignore", stdout: "ignore", stderr: "pipe" },
  );
  const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  expect(code, stderr).toBe(1);
  // Counted, not just found: the reason is reported once, not twice. The second spawn of the missing hc (#1538) is what
  // the next line rules out: without the fix it surfaces as a raw "could not stop everything" error.
  expect(stderr.split(`herdr-core was not found at ${missing}`).length - 1, stderr).toBe(1);
  expect(stderr).not.toContain("could not stop everything");
}, 10_000);

/** Virtual time for the fake host's deadlines: one fires only when the test moves time past it. */
class TestClock implements DeadlineClock {
  #now = 0;
  #timers = new Map<symbol, { readonly at: number; readonly run: () => void }>();

  after(ms: number, run: () => void): () => void {
    const id = Symbol("deadline");
    this.#timers.set(id, { at: this.#now + ms, run });
    return () => this.#timers.delete(id);
  }

  advance(ms: number): void {
    this.#now += ms;
    for (const [id, timer] of [...this.#timers].toSorted(([, x], [, y]) => x.at - y.at)) {
      if (timer.at > this.#now || !this.#timers.delete(id)) continue;
      timer.run();
    }
  }

  /** When each armed deadline falls due. */
  due(): readonly number[] {
    return [...this.#timers.values()].map((timer) => timer.at);
  }
}

test("a pairing link asked for long after the start gets its own deadline, not the start's (#502)", async () => {
  // The test's clock runs the deadlines, so how long the host takes to start or to answer cannot spend them (#780).
  const clock = new TestClock();
  const host = await startFakeRelayHost({ machine: true, stageDeadlineMs: 1_500, clock });
  try {
    expect(clock.due()).toEqual([]);
    // The time between the start and this ask is the condition: a window left over from the startup would be spent.
    clock.advance(1_800);
    const link = host.pairingLink();
    expect(clock.due()).toEqual([3_300]);
    expect(await link).toContain("/pair#");
    expect(clock.due()).toEqual([]);
  } finally {
    await host.stop();
  }
}, 60_000);

test("a start that reports its stages resolves, and a pairing link comes back over the same channel", async () => {
  // The test's clock runs the deadlines, so a loaded host's start and pair may take any wall-clock time: this case is
  // about the lines coming back, not about how fast they do (#1101).
  const host = await startFakeRelayHost({ machine: true, clock: new TestClock() });
  try {
    expect(await host.pairingLink()).toContain("/pair#");
  } finally {
    await host.stop();
  }
}, 60_000);
