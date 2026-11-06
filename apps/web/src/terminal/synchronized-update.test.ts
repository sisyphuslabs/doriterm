import { describe, expect, test } from "bun:test";
import { SynchronizedUpdate } from "./synchronized-update.ts";

const text = (value: string) => new TextEncoder().encode(value);

/** Feeds `chunks` in order: what each read, and whether an update is open after it. */
function feed(chunks: readonly string[]): [number, boolean][] {
  const update = new SynchronizedUpdate();
  return chunks.map((chunk) => [update.advance(text(chunk)), update.open]);
}

describe("SynchronizedUpdate (#757)", () => {
  test.each([
    ["DECSET 2026 opens, DECRST 2026 ends", ["a\u001b[?2026hb", "c\u001b[?2026l"], [true, false]],
    ["among other modes in one sequence", ["\u001b[?25;2026h", "\u001b[?7;2026l"], [true, false]],
    ["a full reset ends it", ["\u001b[?2026h", "x\u001bc"], [true, false]],
    [
      "other modes and sequences leave it",
      ["\u001b[?2026h", "\u001b[?7l\u001b[2J\u001b[3J\u001b[?1049h"],
      [true, true],
    ],
    ["mode 20260 is not 2026", ["\u001b[?20260h"], [false]],
    ["a closing sequence with no open update reads through", ["\u001b[?2026lrest"], [false]],
  ] as const)("%s", (_, chunks, open) => {
    expect(feed(chunks).map(([, isOpen]) => isOpen)).toEqual([...open]);
  });

  test("a sequence split across chunks at every byte is joined", () => {
    const whole = "ab\u001b[?2026hcd\u001b[?2026lef";
    for (let cut = 1; cut < whole.length; cut++) {
      const update = new SynchronizedUpdate();
      update.advance(text(whole.slice(0, cut)));
      update.advance(text(whole.slice(cut)));
      expect(update.open).toBe(false);
      const half = new SynchronizedUpdate();
      half.advance(text(whole.slice(0, Math.min(cut, 11))));
      half.advance(text(whole.slice(Math.min(cut, 11), 11)));
      expect(half.open).toBe(true);
    }
  });

  test("a long list of modes that ends in 2026, split across chunks at every byte, still opens it", () => {
    const modes = Array.from({ length: 30 }, (_, index) => index + 1).join(";");
    const whole = `\u001b[?${modes};2026h`;
    expect(whole.length).toBeGreaterThan(32);
    for (let cut = 1; cut < whole.length; cut++) {
      const update = new SynchronizedUpdate();
      update.advance(text(whole.slice(0, cut)));
      update.advance(text(whole.slice(cut)));
      expect(update.open).toBe(true);
    }
  });

  test("an update that ends inside a chunk is read up to the end of its closing sequence", () => {
    const update = new SynchronizedUpdate();
    update.advance(text("\u001b[?2026h"));
    const chunk = text("lines\u001b[?2026lafter\u001b[?2026h");
    expect(update.advance(chunk)).toBe("lines\u001b[?2026l".length);
    expect(update.open).toBe(false);
    expect(update.advance(chunk.subarray("lines\u001b[?2026l".length))).toBe("after\u001b[?2026h".length);
    expect(update.open).toBe(true);
  });

  test("an end that completes a carried sequence is read up to its last byte", () => {
    const update = new SynchronizedUpdate();
    update.advance(text("\u001b[?2026h"));
    update.advance(text("x\u001b[?20"));
    expect(update.advance(text("26ly"))).toBe(3);
    expect(update.open).toBe(false);
  });
});
