import { describe, expect, test } from "bun:test";
import { confirmed, type Harness, harness, judgements } from "./testing/prediction-harness.ts";

const texts = (h: Harness): string[] => h.predictor.visible().map((cell) => cell.text);

/** A confirmed epoch with the cursor at `col` of `row`, by a key typed and echoed there. */
const confirmedAt = (row: number, col: number): Harness => {
  const h = harness();
  h.screen.at = { row, col: col - 1 };
  confirmed(h);
  return h;
};

describe("the last column and the wrap, as mosh predicts them (terminaloverlay.cc:752-756, 789-795)", () => {
  test("the key in the last column is predicted silently, and the keys after it on the next row too", () => {
    const h = confirmedAt(0, 78);
    h.predictor.typed("a", "key");
    expect(h.predictor.typed("b", "key")).toMatchObject({ kind: "predicted", cell: { row: 0, col: 79 } });
    expect(h.predictor.typed("c", "key")).toMatchObject({ kind: "predicted", cell: { row: 1, col: 0 } });
    expect(h.predictor.typed("d", "key")).toMatchObject({ kind: "predicted", cell: { row: 1, col: 1 } });
    expect(texts(h)).toEqual(["a"]);
  });

  test("the echo of a key on the next row makes the rest of that row drawn, and nothing is judged on the way", () => {
    const h = confirmedAt(0, 78);
    for (const key of "abcde") h.predictor.typed(key, "key");
    h.hostEchoes("ab");
    expect(h.screen.cursor()).toEqual({ row: 0, col: 79 });
    expect(texts(h)).toEqual([]);
    h.hostEchoes("c");
    expect(texts(h)).toEqual(["d", "e"]);
    expect(h.predictor.visibleCursor()).toEqual({ row: 1, col: 3 });
    h.hostEchoes("de");
    expect([texts(h), judgements(h)]).toEqual([[], []]);
  });

  test("a key typed while the terminal's wrap is pending is predicted silently, and dropped when it lands below", () => {
    const h = confirmedAt(0, 79);
    h.predictor.typed("x", "key");
    h.hostEchoes("x");
    expect(h.screen.cursor()).toEqual({ row: 0, col: 79 });
    expect(h.predictor.typed("y", "key")).toMatchObject({ kind: "predicted", cell: { row: 0, col: 79 } });
    expect(texts(h)).toEqual([]);
    h.hostEchoes("y");
    expect([texts(h), judgements(h)]).toEqual([[], ["killEpoch:row-left"]]);
  });

  test("a wide glyph ending in the last column wraps too; one that does not fit is refused (P4)", () => {
    const h = confirmedAt(0, 78);
    expect(h.predictor.typed("가", "key")).toMatchObject({ kind: "predicted", cell: { row: 0, col: 78, width: 2 } });
    expect(h.predictor.typed("a", "key")).toMatchObject({ kind: "predicted", cell: { row: 1, col: 0 } });
  });

  test("on the last row the wrap scrolls the screen: the next keys are predicted on that row from column 0", () => {
    const h = confirmedAt(23, 79);
    h.predictor.typed("p", "key");
    expect(h.predictor.typed("q", "key")).toMatchObject({ kind: "predicted", cell: { row: 23, col: 0 } });
    h.predictor.typed("r", "key");
    h.hostEchoes("p");
    h.hostEchoes("q");
    expect(h.screen.cell(22, 79)).toMatchObject({ char: "p".codePointAt(0) });
    expect([texts(h), judgements(h)]).toEqual([["r"], []]);
  });
});
