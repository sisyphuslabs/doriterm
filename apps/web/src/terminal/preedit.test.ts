import { describe, expect, test } from "bun:test";
import { GhosttyCore } from "@wterm/ghostty";
import { ghosttyWasmUrl } from "@doriface/ghostty-wasm";
import { CodepointWidths, type PreeditCodepoint, preeditRange } from "./preedit.ts";

const narrow = (text: string): PreeditCodepoint => ({ text, wide: false });
const wide = (text: string): PreeditCodepoint => ({ text, wide: true });

// Ghostty's own cases for Preedit.range (src/renderer/State.zig), with max as the last column.
describe("preeditRange, as Ghostty places a preedit", () => {
  test("a narrow codepoint covers its one cell at the cursor", () => {
    expect(preeditRange([narrow("a")], 2, 9)).toEqual({ start: 2, end: 2, offset: 0 });
  });

  test("a wide codepoint covers two cells at the cursor", () => {
    expect(preeditRange([wide("\u{AC00}")], 2, 9)).toEqual({ start: 2, end: 3, offset: 0 });
  });

  test("at the last column a wide codepoint shifts left so both its cells are on the row", () => {
    expect(preeditRange([wide("\u{AC00}")], 9, 9)).toEqual({ start: 8, end: 9, offset: 0 });
  });

  test("a preedit wider than the row keeps its end and drops its first codepoints", () => {
    const text = [wide("\u{AC00}"), wide("\u{AC01}"), wide("\u{AC02}")];
    expect(preeditRange(text, 0, 3)).toEqual({ start: 0, end: 3, offset: 1 });
    expect(preeditRange(text, 2, 3)).toEqual({ start: 0, end: 3, offset: 1 });
    expect(preeditRange([narrow("a"), wide("\u{AC00}")], 2, 3)).toEqual({ start: 1, end: 3, offset: 0 });
  });
});

describe("CodepointWidths", () => {
  test("widths come from the terminal's own core: Hangul, compatibility jamo and kana are wide, ASCII is not", async () => {
    const widths = new CodepointWidths(() => GhosttyCore.load({ wasmPath: ghosttyWasmUrl }));
    try {
      expect(await widths.of("\u{D55C}a\u{3131}\u{3042}")).toEqual([
        wide("\u{D55C}"),
        narrow("a"),
        wide("\u{3131}"),
        wide("\u{3042}"),
      ]);
    } finally {
      widths.dispose();
    }
  });

  test("a codepoint already measured is answered without the core", async () => {
    let loads = 0;
    const widths = new CodepointWidths(() => {
      loads += 1;
      return GhosttyCore.load({ wasmPath: ghosttyWasmUrl });
    });
    try {
      await widths.of("\u{D55C}");
      await widths.of("\u{D55C}");
      expect(loads).toBe(1);
    } finally {
      widths.dispose();
    }
  });
});

/** A one-row core that calls a code point wide from U+1100 up, and counts what it was asked to measure. */
function fakeCore(measured: number[]): GhosttyCore {
  let last = 0;
  const core = {
    init: () => undefined,
    writeString: (text: string, done: () => void) => {
      last = [...text].at(-1)?.codePointAt(0) ?? 0;
      measured.push(last);
      done();
    },
    getCell: () => ({ char: last, width: last >= 0x1100 ? 2 : 1 }),
    dispose: () => undefined,
  };
  // Only the members CodepointWidths calls are faked.
  return core as unknown as GhosttyCore;
}

/** An idle scheduler stepped by hand: each step runs one queued slice to its end. */
function manualIdle(): {
  schedule: (work: () => Promise<void>) => void;
  step: () => Promise<boolean>;
  drain: () => Promise<void>;
} {
  const queue: (() => Promise<void>)[] = [];
  const step = async (): Promise<boolean> => {
    const next = queue.shift();
    if (next === undefined) return false;
    await next();
    return true;
  };
  const drain = async (): Promise<void> => {
    if (await step()) await drain();
  };
  return { schedule: (work) => void queue.push(work), step, drain };
}

describe("CodepointWidths.known and warm, for a synchronous widthOf (P7)", () => {
  test("known is undefined before a code point is measured and its wide flag after", async () => {
    const widths = new CodepointWidths(() => Promise.resolve(fakeCore([])));
    expect(widths.known(0xac00)).toBeUndefined();
    expect(widths.known(0x61)).toBeUndefined();
    await widths.of("\u{AC00}a");
    expect(widths.known(0xac00)).toBe(true);
    expect(widths.known(0x61)).toBe(false);
  });

  test("warm measures each range in idle slices until every code point is known", async () => {
    const measured: number[] = [];
    const idle = manualIdle();
    const widths = new CodepointWidths(() => Promise.resolve(fakeCore(measured)), idle.schedule);
    widths.warm([
      [0x41, 0x43],
      [0xac00, 0xac01],
    ]);
    expect(widths.known(0x41)).toBeUndefined();
    await idle.drain();
    expect([0x41, 0x42, 0x43].map((each) => widths.known(each))).toEqual([false, false, false]);
    expect([0xac00, 0xac01].map((each) => widths.known(each))).toEqual([true, true]);
    expect(measured).toEqual([0x41, 0x42, 0x43, 0xac00, 0xac01]);
  });

  test("a slice is 512 code points, and a cancelled warm measures no further slice", async () => {
    const measured: number[] = [];
    const idle = manualIdle();
    const widths = new CodepointWidths(() => Promise.resolve(fakeCore(measured)), idle.schedule);
    const cancel = widths.warm([[0xac00, 0xac00 + 1199]]);
    expect(await idle.step()).toBe(true);
    expect(measured).toHaveLength(512);
    expect(widths.known(0xac00 + 511)).toBe(true);
    expect(widths.known(0xac00 + 512)).toBeUndefined();
    cancel();
    await idle.drain();
    expect(measured).toHaveLength(512);
    expect(widths.known(0xac00 + 512)).toBeUndefined();
  });

  test("warm skips code points already known", async () => {
    const measured: number[] = [];
    const idle = manualIdle();
    const widths = new CodepointWidths(() => Promise.resolve(fakeCore(measured)), idle.schedule);
    await widths.of("b");
    widths.warm([[0x61, 0x63]]);
    await idle.drain();
    expect(measured).toEqual([0x62, 0x61, 0x63]);
  });
});
