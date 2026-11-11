import { expect, test } from "bun:test";
import { FakeCore, machine } from "./fake-core.test-support.ts";
import { LINE_READ_MS } from "./line-watch.ts";
import { MACHINE_REFRESH_MS, Roster } from "./roster.ts";

/** A roster on `core` whose timers run only when `tick(ms)` says, counting how often it notifies its listeners. */
function rosterOn(core: FakeCore) {
  const timers: { readonly run: () => void; readonly ms: number }[] = [];
  const link = core.connection();
  const roster = new Roster(link, {
    every: (run, ms) => {
      const timer = { run, ms };
      timers.push(timer);
      return () => void timers.splice(timers.indexOf(timer), 1);
    },
    whenVisible: () => () => undefined,
    schedule: (run) => (queueMicrotask(run), () => undefined),
    now: () => 1_000,
  });
  const seen = { notified: 0 };
  roster.subscribe(() => (seen.notified += 1));
  return {
    roster,
    link,
    seen,
    tick: (ms: number) => {
      for (const timer of timers.filter((each) => each.ms === ms)) timer.run();
    },
    reads: () => core.calls.filter((call) => call === "machine.list").length,
  };
}

/** Resolves once `ok` holds, woken by the roster's notifications; fails loudly instead of hanging. */
function until(roster: Roster, ok: () => boolean, label: string): Promise<void> {
  if (ok()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      stop();
      reject(new Error(`timed out waiting for ${label}`));
    }, 2_000);
    const stop = roster.subscribe(() => {
      if (!ok()) return;
      clearTimeout(timer);
      stop();
      resolve();
    });
  });
}

/** The first reads (the line read and the feed's gap read) are in, and no line read is in flight. */
async function started(roster: Roster, reads: number): Promise<void> {
  await until(roster, () => roster.snapshot.machines.listed >= reads, "the first reads");
  await roster.linesIdle();
}

test("a line read that changes nothing notifies no one; a changed line, and every 10 s read, still do (#2184)", async () => {
  const core = new FakeCore();
  core.machines = [machine("rack")];
  const { roster, seen, tick, reads } = rosterOn(core);
  roster.watchLines();
  await started(roster, 2);
  const before = { notified: seen.notified, reads: reads(), listed: roster.snapshot.machines.listed };

  tick(LINE_READ_MS);
  await roster.linesIdle();
  tick(LINE_READ_MS);
  await roster.linesIdle();
  expect([reads() - before.reads, seen.notified - before.notified]).toEqual([2, 0]);

  // The 10 s read is the count useDeadPanes waits on for an added machine's absent pane, so it moves on regardless.
  tick(MACHINE_REFRESH_MS);
  await until(roster, () => seen.notified > before.notified, "the 10 s read");
  expect(seen.notified - before.notified).toBe(1);
  expect(roster.snapshot.machines.listed).toBe(before.listed + 3);

  core.machines = [machine("rack", "connecting")];
  tick(LINE_READ_MS);
  await roster.linesIdle();
  expect(seen.notified - before.notified).toBe(2);
  expect(roster.snapshot.machines.views.map((view) => view.state)).toEqual(["connecting"]);
});

test("a line read still waiting for its answer sends no second one, and a closed connection is read no more (#2184)", async () => {
  const core = new FakeCore();
  core.machines = [machine("rack")];
  const { roster, link, tick, reads } = rosterOn(core);
  await started(roster, 1);
  const held = Promise.withResolvers<void>();
  core.holdMachineList = held.promise;
  const before = reads();
  roster.watchLines();
  tick(LINE_READ_MS);
  tick(LINE_READ_MS);
  expect(reads() - before).toBe(1);

  held.resolve();
  await roster.linesIdle();
  tick(LINE_READ_MS);
  expect(reads() - before).toBe(2);
  await roster.linesIdle();

  link.drop();
  tick(LINE_READ_MS);
  expect(reads() - before).toBe(2);
  await roster.linesIdle();

  // A reconnect attaches a new connection to the same roster: the line read goes on there (#2197).
  roster.attach(core.connection());
  tick(LINE_READ_MS);
  expect(reads() - before).toBe(3);
});

test("a told read that a quiet line read overtakes is still told, so the read count moves on (#2197)", async () => {
  const core = new FakeCore();
  core.machines = [machine("rack")];
  const { roster, seen, tick } = rosterOn(core);
  roster.watchLines();
  await started(roster, 2);
  const before = { notified: seen.notified, listed: roster.snapshot.machines.listed };

  // The 10 s read waits on a slow answer while the next line read, sent after it, answers first and changes nothing.
  const held = Promise.withResolvers<void>();
  core.holdMachineList = held.promise;
  const told = roster.refreshMachines();
  core.holdMachineList = undefined;
  tick(LINE_READ_MS);
  await roster.linesIdle();
  held.resolve();
  await told;

  // The overtaken answer is dropped as stale, so the told one is the quiet read that applied: the count moves on by it.
  expect(seen.notified - before.notified).toBe(1);
  expect(roster.snapshot.machines).toBe(roster.machines.read);
  expect(roster.snapshot.machines.listed).toBe(before.listed + 1);
});

test("a told read overtaken by a quiet line read that fails as the last read did is still told (#2207)", async () => {
  const core = new FakeCore();
  core.machines = [machine("rack")];
  const { roster, seen, tick, reads } = rosterOn(core);
  roster.watchLines();
  await started(roster, 2);
  core.failMachineList = true;
  await roster.refreshMachines();
  const failed = roster.snapshot.machines.error;
  const before = { notified: seen.notified, reads: reads() };

  // The 10 s read waits on a slow answer; the next line read, sent after it, fails at once with the same error.
  const held = Promise.withResolvers<void>();
  core.holdMachineList = held.promise;
  const told = roster.refreshMachines();
  core.holdMachineList = undefined;
  tick(LINE_READ_MS);
  await roster.linesIdle();
  // Both reads went out, and the quiet one has answered while the told one is still held: it overtook it (#2223).
  expect(reads() - before.reads).toBe(2);
  held.resolve();
  await told;

  expect(failed).toBeDefined();
  expect(seen.notified - before.notified).toBe(1);
  expect(roster.snapshot.machines).toBe(roster.machines.read);
});
