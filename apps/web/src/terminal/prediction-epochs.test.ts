import { describe, expect, test } from "bun:test";
import { confirmed, type Harness, harness } from "./testing/prediction-harness.ts";

const texts = (h: Harness): string[] => h.predictor.visible().map((cell) => cell.text);
const DUE = 495;

/** The host answers a submitted line: the cursor goes to the start of the next row, and the view says it wrote. */
const nextRow = (h: Harness): void => {
  h.screen.at = { row: h.screen.at.row + 1, col: 0 };
  h.predictor.wrote();
};

describe("epochs (design note D3)", () => {
  test("the first prediction after a fresh start is not drawn; once one is echoed the rest of its epoch is", () => {
    const h = harness();
    h.predictor.typed("a", "key");
    h.predictor.typed("b", "key");
    expect(texts(h)).toEqual([]);
    expect(h.predictor.visibleCursor()).toBeNull();
    expect([h.screen.cell(0, 0), h.screen.cell(0, 1)]).toEqual([{ char: 0 }, { char: 0 }]);
    h.hostEchoes("a");
    expect(texts(h)).toEqual(["b"]);
    expect(h.predictor.visibleCursor()).toEqual({ row: 0, col: 2 });
    h.hostEchoes("b");
    expect(texts(h)).toEqual([]);
    h.predictor.typed("c", "key");
    expect(texts(h)).toEqual(["c"]);
  });

  test("reset() starts an unconfirmed epoch: the next key is not drawn before its echo", () => {
    const h = harness();
    confirmed(h);
    h.predictor.typed("a", "key");
    expect(texts(h)).toEqual(["a"]);
    h.predictor.reset();
    expect(texts(h)).toEqual([]);
    h.predictor.typed("d", "key");
    expect(texts(h)).toEqual([]);
  });

  test("a key the host never echoes is drawn at most `due`; after that kill every key is silent until one is echoed", () => {
    const h = harness();
    confirmed(h);
    h.predictor.typed("p", "key");
    expect(texts(h)).toEqual(["p"]);
    h.clock.now += DUE;
    h.predictor.tick(h.clock.now);
    expect(texts(h)).toEqual([]);
    for (const key of "assword") {
      h.clock.now += 100;
      h.predictor.typed(key, "key");
      h.predictor.tick(h.clock.now);
      expect(texts(h)).toEqual([]);
    }
  });

  test("after a kill, the first echo of the new epoch confirms it and the keys after it are drawn again", () => {
    const h = harness();
    confirmed(h);
    h.predictor.typed("a", "key");
    h.clock.now += DUE;
    h.predictor.tick(h.clock.now);
    h.predictor.typed("b", "key");
    h.predictor.typed("c", "key");
    expect(texts(h)).toEqual([]);
    h.hostEchoes("b");
    expect(texts(h)).toEqual(["c"]);
  });
});

describe("a submitted line starts a new epoch (mosh become_tentative on CR)", () => {
  test("a key typed after Enter is not drawn before its echo; the same key typed without Enter is", () => {
    const h = harness();
    confirmed(h);
    h.predictor.typed("\r", "key");
    nextRow(h);
    expect(h.predictor.typed("x", "key")).toMatchObject({ kind: "predicted", cell: { row: 1, col: 0 } });
    expect(texts(h)).toEqual([]);
    h.hostEchoes("x");
    h.predictor.typed("y", "key");
    expect(texts(h)).toEqual(["y"]);
    const control = harness();
    confirmed(control);
    control.predictor.typed("x", "key");
    expect(texts(control)).toEqual(["x"]);
  });

  test("the password prompt: no key typed after the command's Enter is ever drawn", () => {
    const h = harness();
    confirmed(h, "s");
    h.predictor.typed("\r", "key");
    nextRow(h);
    h.screen.echo("pw: ");
    h.predictor.wrote();
    for (const key of "secret") {
      h.clock.now += 100;
      h.predictor.typed(key, "key");
      h.predictor.tick(h.clock.now);
      expect([key, texts(h), h.predictor.visibleCursor()]).toEqual([key, [], null]);
    }
  });

  test("LF, kitty-encoded Enter (with modifiers) and a pasted line each submit a line", () => {
    const submits: [string, "key" | "paste"][] = [
      ["\n", "key"],
      ["\u001B[13u", "key"],
      ["\u001B[13;5u", "key"],
      ["ls\r", "paste"],
    ];
    for (const [input, source] of submits) {
      const h = harness();
      confirmed(h);
      h.predictor.typed(input, source);
      nextRow(h);
      h.predictor.typed("x", "key");
      expect([JSON.stringify(input), texts(h)]).toEqual([JSON.stringify(input), []]);
    }
  });

  test("keys typed before Enter stay drawn until their echo, and that echo does not vouch for the keys after it", () => {
    const h = harness();
    confirmed(h);
    h.predictor.typed("a", "key");
    h.predictor.typed("b", "key");
    h.predictor.typed("\r", "key");
    expect(texts(h)).toEqual(["a", "b"]);
    expect(h.predictor.visibleCursor()).toEqual({ row: 0, col: 3 });
    h.hostEchoes("ab");
    expect(texts(h)).toEqual([]);
    nextRow(h);
    h.predictor.typed("x", "key");
    expect(texts(h)).toEqual([]);
  });
});
