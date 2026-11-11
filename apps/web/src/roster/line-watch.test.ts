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

/** Lets the fake core's answers, which settle without a timer, land, and the line read's in-flight mark clear. */
const answered = (): Promise<void> =>
  Array.from({ length: 10 }).reduce<Promise<void>>((turn) => turn.then(() => undefined), Promise.resolve());

test("a line read that changes nothing notifies no one; a changed line, and every 10 s read, still do (#2184)", async () => {
  const core = new FakeCore();
  core.machines = [machine("rack")];
  const { roster, seen, tick, reads } = rosterOn(core);
  roster.watchLines();
  await answered();
  const before = { notified: seen.notified, reads: reads(), listed: roster.snapshot.machines.listed };

  tick(LINE_READ_MS);
  await answered();
  tick(LINE_READ_MS);
  await answered();
  expect([reads() - before.reads, seen.notified - before.notified]).toEqual([2, 0]);

  // The 10 s read is the count useDeadPanes waits on for an added machine's absent pane, so it moves on regardless.
  tick(MACHINE_REFRESH_MS);
  await answered();
  expect(seen.notified - before.notified).toBe(1);
  expect(roster.snapshot.machines.listed).toBe(before.listed + 3);

  core.machines = [machine("rack", "connecting")];
  tick(LINE_READ_MS);
  await answered();
  expect(seen.notified - before.notified).toBe(2);
  expect(roster.snapshot.machines.views.map((view) => view.state)).toEqual(["connecting"]);
});

test("a line read still waiting for its answer sends no second one, and a closed connection is read no more (#2184)", async () => {
  const core = new FakeCore();
  core.machines = [machine("rack")];
  const { roster, link, tick, reads } = rosterOn(core);
  await answered();
  const held = Promise.withResolvers<void>();
  core.holdMachineList = held.promise;
  const before = reads();
  roster.watchLines();
  tick(LINE_READ_MS);
  tick(LINE_READ_MS);
  expect(reads() - before).toBe(1);

  held.resolve();
  await answered();
  tick(LINE_READ_MS);
  expect(reads() - before).toBe(2);
  await answered();

  link.drop();
  tick(LINE_READ_MS);
  expect(reads() - before).toBe(2);
});
