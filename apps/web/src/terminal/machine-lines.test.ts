import { expect, test } from "bun:test";
import { FakeCore, machine } from "../roster/fake-core.test-support.ts";
import { LINE_READ_MS } from "../roster/line-watch.ts";
import { MACHINE_REFRESH_MS, Roster } from "../roster/roster.ts";
import { MachineLines } from "./machine-lines.ts";

/**
 * Machine lines on a roster whose timers run only when the test says: `tick(ms)` runs every timer set to that period, and
 * `periods()` lists the periods set now. Every timer that can read `machine.list` is listed there.
 */
function linesOn(core: FakeCore) {
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
  const lines = new MachineLines(() => roster);
  return {
    roster,
    lines,
    // The fake answers the roster's calls by name; MachineLines takes it as the connection the views hold.
    connection: link as never,
    tick: (ms: number) => {
      for (const timer of timers.filter((each) => each.ms === ms)) timer.run();
    },
    periods: () => timers.map((timer) => timer.ms).toSorted((a, b) => a - b),
    reads: () => core.calls.filter((call) => call === "machine.list").length,
  };
}

/** Resolves once `ok` holds, woken by the lines' own changes; fails if it takes `ms`. */
function until(lines: MachineLines, ok: () => boolean, label: string, ms: number): Promise<void> {
  if (ok()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      stop();
      reject(new Error(`timed out waiting for ${label}`));
    }, ms);
    const stop = lines.subscribe(() => {
      if (!ok()) return;
      clearTimeout(timer);
      stop();
      resolve();
    });
  });
}

test("a line drop reaches machine lines through the roster's line read, and machine lines run no timer of their own (#2056)", async () => {
  const core = new FakeCore();
  core.machines = [machine("rack", "connecting")];
  const { roster, lines, connection, tick, periods, reads } = linesOn(core);
  const stop = lines.watch(connection);
  await until(lines, () => lines.down(connection, "rack"), "the first read", 500);
  await roster.linesIdle();
  core.machines = [machine("rack")];
  tick(LINE_READ_MS);
  await until(lines, () => !lines.down(connection, "rack"), "the line back", 500);
  await roster.linesIdle();

  // hc says nothing when a line drops (#2056), so the roster reads machine.list every LINE_READ_MS while a line is
  // watched: the drop is seen on the next read, sooner than the old poll of machine lines could have read it.
  const before = reads();
  core.machines = [machine("rack", "unreachable")];
  tick(LINE_READ_MS);
  await until(lines, () => lines.down(connection, "rack"), "the drop", LINE_READ_MS / 2);
  expect(reads()).toBe(before + 1);
  expect(periods()).toEqual([LINE_READ_MS, MACHINE_REFRESH_MS]);

  stop();
  expect(periods()).toEqual([]);
});

test("two views on one connection share one line read, which ends with the last of them", async () => {
  const core = new FakeCore();
  core.machines = [machine("rack")];
  const { lines, connection, periods } = linesOn(core);
  const first = lines.watch(connection);
  const second = lines.watch(connection);
  expect(periods()).toEqual([LINE_READ_MS, MACHINE_REFRESH_MS]);
  first();
  first();
  expect(periods()).toEqual([LINE_READ_MS, MACHINE_REFRESH_MS]);
  second();
  expect(periods()).toEqual([]);
});

test("a line read down is dated from the first read that found it down, until it reads up again (#2464 review)", () => {
  let now = 1_000;
  const lines = new MachineLines(
    () => {
      throw new Error("not watched");
    },
    () => now,
  );
  const connection = {} as never;
  lines.heard(connection, [{ name: "rack", state: "connected" }]);
  expect(lines.downSince(connection, "rack")).toBeUndefined();
  lines.heard(connection, [{ name: "rack", state: "unreachable", why: "(4404)" }]);
  now = 4_000;
  lines.heard(connection, [{ name: "rack", state: "connecting", why: "(4404)" }]);
  expect(lines.downSince(connection, "rack")).toBe(1_000);
  expect(lines.line(connection, "rack")?.why).toBe("(4404)");
  lines.heard(connection, [{ name: "rack", state: "connected" }]);
  expect(lines.downSince(connection, "rack")).toBeUndefined();
});
