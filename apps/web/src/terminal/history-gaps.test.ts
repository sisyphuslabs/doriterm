import { describe, expect, test } from "bun:test";
import { historyGapRows, markHistoryGap } from "./history-gaps.ts";

/** A view whose history holds `held` lines after dropping `discarded` from its top. */
function view(held: number, discarded = 0) {
  const counts = { held, discarded };
  return {
    counts,
    bridge: {
      getScrollbackCount: () => counts.held,
      getScrollbackDiscardedCount: () => counts.discarded,
    },
  };
}

describe("history gaps", () => {
  test("a reattach marks the row below the history the view held, and it stays there as later lines are pushed", () => {
    const terminal = view(200);
    markHistoryGap(terminal);
    expect(historyGapRows(terminal)).toEqual([200]);
    terminal.counts.held = 260;
    expect(historyGapRows(terminal)).toEqual([200]);
  });

  test("lines discarded from the history's top move the mark up with the lines around it", () => {
    const terminal = view(1000, 0);
    markHistoryGap(terminal);
    terminal.counts.discarded = 300;
    expect(historyGapRows(terminal)).toEqual([700]);
    terminal.counts.discarded = 1200;
    expect(historyGapRows(terminal)).toEqual([0]);
  });

  test("every reattach keeps its own mark, and reattaches with no line between them leave one", () => {
    const terminal = view(50);
    markHistoryGap(terminal);
    markHistoryGap(terminal);
    terminal.counts.held = 120;
    markHistoryGap(terminal);
    expect(historyGapRows(terminal)).toEqual([50, 120]);
  });

  test("a cleared history forgets the marks past it, for good", () => {
    const terminal = view(80);
    markHistoryGap(terminal);
    terminal.counts.held = 0;
    expect(historyGapRows(terminal)).toEqual([]);
    terminal.counts.held = 90;
    expect(historyGapRows(terminal)).toEqual([]);
  });

  test("a view with no history marks nothing, and one never reattached has no marks", () => {
    const blank = { bridge: null };
    markHistoryGap(blank);
    expect(historyGapRows(blank)).toEqual([]);
    expect(historyGapRows(view(10))).toEqual([]);
  });
});
