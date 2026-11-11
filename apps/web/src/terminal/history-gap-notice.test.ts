import { describe, expect, test } from "bun:test";
import { clearHistoryGap, dismissHistoryGap, historyGapFor, noteHistoryGap } from "./history-gap-notice.ts";

describe("history gap notice", () => {
  test("a note belongs to the terminal it was raised for", () => {
    noteHistoryGap("t1", "reconnect");
    expect(historyGapFor("t1")).toBe("reconnect");
    expect(historyGapFor("t2")).toBeNull();
    expect(historyGapFor(null)).toBeNull();
    dismissHistoryGap("t1");
  });

  test("a lost stream on a live connection is told apart from a reconnect, and a reconnect wins once raised", () => {
    noteHistoryGap("t3", "stream");
    expect(historyGapFor("t3")).toBe("stream");
    noteHistoryGap("t3", "reconnect");
    noteHistoryGap("t3", "stream");
    expect(historyGapFor("t3")).toBe("reconnect");
    dismissHistoryGap("t3");
  });

  test("dismissing or clearing one terminal's note leaves another's", () => {
    noteHistoryGap("t4", "reconnect");
    noteHistoryGap("t5", "reconnect");
    dismissHistoryGap("t4");
    expect(historyGapFor("t4")).toBeNull();
    expect(historyGapFor("t5")).toBe("reconnect");
    clearHistoryGap("t5");
    expect(historyGapFor("t5")).toBeNull();
  });
});
