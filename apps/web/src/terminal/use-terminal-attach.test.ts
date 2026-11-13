import { describe, expect, test } from "bun:test";
import { OutputPacer, REPLAY_CAP_MS } from "./output-pacer.ts";
import { afterMachineWait, attachDue, machineWait, replayOnAttach } from "./use-terminal-attach.ts";

/** A pacer on frames and timers that move only when the test says so, recording each hold of the paint. */
function attaching(fresh = false) {
  let now = 0;
  const due: { at: number; run: () => void }[] = [];
  const timer = (run: () => void, ms: number): (() => void) => {
    const entry = { at: now + ms, run };
    due.push(entry);
    return () => {
      const at = due.indexOf(entry);
      if (at !== -1) due.splice(at, 1);
    };
  };
  const advance = (ms: number): void => {
    const until = now + ms;
    for (;;) {
      const next = due.filter((entry) => entry.at <= until).toSorted((a, b) => a.at - b.at)[0];
      if (next === undefined) break;
      due.splice(due.indexOf(next), 1);
      now = next.at;
      next.run();
    }
    now = until;
  };
  const holds: boolean[] = [];
  const pacer = new OutputPacer(
    () => undefined,
    () => () => undefined,
    () => now,
    timer,
  );
  replayOnAttach(pacer, { srtt: () => 300, hold: (held) => holds.push(held) }, fresh);
  return { pacer, holds, advance };
}

describe("an attach's replay hold (D5)", () => {
  test("a view mounted anew holds its first paint too: its replay covers history, held the same way (#812)", () => {
    const { pacer, holds, advance } = attaching();
    expect(holds).toEqual([true]);
    pacer.push(new Uint8Array(64 * 1024));
    advance(REPLAY_CAP_MS * 2);
    expect(holds).toEqual([true, false]);
  });

  test("a reattach under output that never stops is held, then let go at the cap: hc marks no end of the replay", () => {
    const { pacer, holds, advance } = attaching();
    expect(holds).toEqual([true]);
    for (let at = 0; at < REPLAY_CAP_MS - 50; at += 50) {
      pacer.push(new Uint8Array(1024));
      advance(50);
    }
    pacer.push(new Uint8Array(1024));
    advance(49);
    expect(holds).toEqual([true]);
    advance(1);
    expect(holds).toEqual([true, false]);
  });

  test("a terminal this page just started is not held: it has no history, so its first prompt is drawn as it arrives (#1928)", () => {
    const { pacer, holds, advance } = attaching(true);
    pacer.push(new Uint8Array(1024));
    advance(REPLAY_CAP_MS * 2);
    expect(holds).toEqual([]);
  });
});

describe("a failed open cleared to wait for its machine (#2003, #2375 review)", () => {
  test("the same renderer attaches again once the machine is back, though it was marked attached", () => {
    const view = {};
    const connection = {};
    const failed = { view, connection, reattachedFor: 0 };
    expect(attachDue(failed, view, connection, 0)).toBe(false);
    expect(attachDue(failed, view, connection, afterMachineWait(0))).toBe(true);
  });
});

test("waiting for the machine clears the failure and moves the lost-stream count on (#2375 review)", () => {
  const unopened: (string | null)[] = [];
  let lost = 0;
  machineWait(
    (reason) => unopened.push(reason),
    (next) => {
      lost = next(lost);
    },
  )();
  expect({ unopened, lost }).toEqual({ unopened: [null], lost: 1 });
});
