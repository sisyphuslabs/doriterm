import { describe, expect, test } from "bun:test";
import { OutputPacer, REPLAY_CAP_MS } from "./output-pacer.ts";
import { replayOnAttach, writeQueued } from "./use-terminal-attach.ts";

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

  test("keys the person typed while the link was down let the new replay go before they are written, so their echo is drawn (#2794)", () => {
    const { pacer, holds } = attaching();
    const events: string[] = [];
    const pending = ["l", "s"];
    const typed = { current: true };
    writeQueued(pacer, pending, typed, (data) => events.push(`${String(holds.at(-1))} ${String(data)}`));
    expect(holds).toEqual([true, false]);
    expect(events).toEqual(["false l", "false s"]);
    expect([pending, typed.current]).toEqual([[], false]);
  });

  test("queued answers the terminal gave to a program's queries, with nothing the person typed, leave the replay held", () => {
    const { pacer, holds } = attaching();
    const written: unknown[] = [];
    writeQueued(pacer, ["\u001b[?62c"], { current: false }, (data) => written.push(data));
    expect(written).toEqual(["\u001b[?62c"]);
    expect(holds).toEqual([true]);
  });

  test("a terminal this page just started is not held: it has no history, so its first prompt is drawn as it arrives (#1928)", () => {
    const { pacer, holds, advance } = attaching(true);
    pacer.push(new Uint8Array(1024));
    advance(REPLAY_CAP_MS * 2);
    expect(holds).toEqual([]);
  });
});
