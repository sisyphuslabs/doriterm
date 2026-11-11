import { describe, expect, test } from "bun:test";
import { OutputPacer, REPLAY_CAP_MS } from "./output-pacer.ts";
import { replayOnAttach } from "./use-terminal-attach.ts";

/** A pacer on frames and timers that move only when the test says so, recording each hold of the paint. */
function attaching(reattach: boolean) {
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
  replayOnAttach(pacer, reattach, { srtt: () => 300, hold: (held) => holds.push(held) });
  return { pacer, holds, advance };
}

describe("an attach's replay hold (D5)", () => {
  test("the first open of a terminal never holds its paint", () => {
    const { pacer, holds, advance } = attaching(false);
    pacer.push(new Uint8Array(64 * 1024));
    advance(REPLAY_CAP_MS * 2);
    expect(holds).toEqual([]);
  });

  test("a reattach under output that never stops is held, then let go at the cap: hc marks no end of the replay", () => {
    const { pacer, holds, advance } = attaching(true);
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
});
