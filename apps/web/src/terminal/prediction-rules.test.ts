import { describe, expect, test } from "bun:test";
import { readInput } from "./prediction-rules.ts";
import { confirmed, harness } from "./testing/prediction-harness.ts";

const texts = (h: ReturnType<typeof harness>): string[] => h.predictor.visible().map((cell) => cell.text);

describe("readInput", () => {
  test("one printable grapheme, a lone backspace, or anything else", () => {
    expect(readInput("a")).toEqual({ kind: "grapheme", text: "a", codepoints: 1 });
    expect(readInput("가")).toEqual({ kind: "grapheme", text: "가", codepoints: 1 });
    expect(readInput("e\u0301")).toEqual({ kind: "grapheme", text: "e\u0301", codepoints: 2 });
    expect(readInput(new Uint8Array([0x7f]))).toEqual({ kind: "backspace" });
    expect(readInput("\b")).toEqual({ kind: "backspace" });
    for (const other of ["", "\r", "\t", "\u001B", "\u001B[A", "\u001B[97;5u", "ab", "\u0085", "\u007F\u007F"]) {
      expect(readInput(other)).toEqual({ kind: "other" });
    }
    expect(readInput(new Uint8Array([0xff]))).toEqual({ kind: "other" });
    expect(readInput(new TextEncoder().encode("가"))).toEqual({ kind: "grapheme", text: "가", codepoints: 1 });
  });
});

describe("the suppression table (design note D4)", () => {
  test("a printable key in a confirmed epoch is predicted and drawn: the control every refusal below departs from", () => {
    const h = harness();
    confirmed(h);
    expect(h.predictor.typed("a", "key")).toMatchObject({ kind: "predicted", cell: { row: 0, col: 1, width: 1 } });
    expect(texts(h)).toEqual(["a"]);
  });

  test("P1: Enter, an arrow, an encoded key, Tab and a multi-character string are never predicted", () => {
    for (const input of ["\r", "\u001B[A", "\u001B[99;5u", "\t", "ls"]) {
      const h = harness();
      confirmed(h);
      expect(h.predictor.typed(input, "key")).toEqual({ kind: "refused", rule: "P1" });
      expect(texts(h)).toEqual([]);
    }
  });

  test("P2: one character pasted is not predicted, though the same character typed is", () => {
    const h = harness();
    confirmed(h);
    expect(h.predictor.typed("a", "paste")).toEqual({ kind: "refused", rule: "P2" });
    expect(texts(h)).toEqual([]);
  });

  test("P3: on the alternate screen a letter is a command, not text", () => {
    const h = harness();
    confirmed(h);
    h.screen.alt = true;
    expect(h.predictor.typed("j", "key")).toEqual({ kind: "refused", rule: "P3" });
    expect(texts(h)).toEqual([]);
  });

  test("P4: nothing is predicted into the last column; one cell left of it is", () => {
    const h = harness();
    confirmed(h);
    h.screen.at = { row: 0, col: 79 };
    h.predictor.wrote();
    expect(h.predictor.typed("a", "key")).toEqual({ kind: "refused", rule: "P4" });
    const left = harness();
    confirmed(left);
    left.screen.at = { row: 0, col: 78 };
    left.predictor.wrote();
    expect(left.predictor.typed("a", "key")).toMatchObject({ kind: "predicted", cell: { col: 78 } });
  });

  test("P5: while an input method composes, the preedit shows it and nothing is predicted", () => {
    const h = harness();
    confirmed(h);
    h.link.composing = true;
    expect(h.predictor.typed("ㄱ", "key")).toEqual({ kind: "refused", rule: "P5" });
    expect(texts(h)).toEqual([]);
  });

  test("P6: input typed while the link is unproven (or queued) is not predicted", () => {
    const h = harness();
    confirmed(h);
    h.link.ready = false;
    expect(h.predictor.typed("a", "key")).toEqual({ kind: "refused", rule: "P6" });
    expect(texts(h)).toEqual([]);
  });

  test("P7: a Hangul syllable is one two-cell prediction, refused at cols - 2 where a narrow key is not", () => {
    const h = harness();
    confirmed(h);
    expect(h.predictor.typed("가", "key")).toMatchObject({ kind: "predicted", cell: { col: 1, width: 2, text: "가" } });
    expect(h.predictor.visibleCursor()).toEqual({ row: 0, col: 3 });
    const edge = harness();
    confirmed(edge);
    edge.screen.at = { row: 0, col: 78 };
    edge.predictor.wrote();
    expect(edge.predictor.typed("가", "key")).toEqual({ kind: "refused", rule: "P4" });
  });

  test("P7: a multi-codepoint grapheme, or a code point of unknown width, is not predicted", () => {
    for (const input of ["e\u0301", "👍🏽", "?"]) {
      const h = harness();
      confirmed(h);
      expect(h.predictor.typed(input, "key")).toEqual({ kind: "refused", rule: "P7" });
    }
  });

  test("P8: backspace pops the last unconfirmed prediction, and the next key goes where it was", () => {
    const h = harness();
    confirmed(h);
    h.predictor.typed("a", "key");
    h.predictor.typed("b", "key");
    expect(h.predictor.typed("\u007F", "key")).toMatchObject({ kind: "popped", rule: "P8", cell: { text: "b" } });
    expect(texts(h)).toEqual(["a"]);
    expect(h.predictor.typed("c", "key")).toMatchObject({ kind: "predicted", cell: { col: 2 } });
    expect(texts(h)).toEqual(["a", "c"]);
  });

  test("P8: backspace over text the host already echoed is the program's business (P1)", () => {
    const h = harness();
    confirmed(h);
    expect(h.predictor.typed("\u007F", "key")).toEqual({ kind: "refused", rule: "P1" });
    expect(h.predictor.typed("a", "key")).toEqual({ kind: "refused", rule: "P9" });
  });

  test("P9: after Enter nothing new is predicted until a host write moves the cursor, then from the real cursor", () => {
    const h = harness();
    confirmed(h);
    h.predictor.typed("\r", "key");
    expect(h.predictor.typed("x", "key")).toEqual({ kind: "refused", rule: "P9" });
    h.screen.at = { row: 1, col: 0 };
    h.predictor.wrote();
    expect(h.predictor.typed("x", "key")).toMatchObject({ kind: "predicted", cell: { row: 1, col: 0 } });
  });

  test("P9: a write that leaves earlier predictions outstanding does not re-sync, so the freeze holds", () => {
    const h = harness();
    confirmed(h);
    h.predictor.typed("a", "key");
    h.predictor.typed("b", "key");
    h.predictor.typed("\r", "key");
    h.hostEchoes("a");
    expect(h.predictor.typed("c", "key")).toEqual({ kind: "refused", rule: "P9" });
    h.hostEchoes("b");
    expect(h.predictor.typed("c", "key")).toMatchObject({ kind: "predicted", cell: { col: 3 } });
  });

  test("every refusal of input that reaches the program freezes; P10 and P12 input never types, so it does not", () => {
    const freezing: [string, (h: ReturnType<typeof harness>) => unknown][] = [
      ["P1", (h) => h.predictor.typed("\r", "key")],
      ["P2", (h) => h.predictor.typed("a", "paste")],
      [
        "P3",
        (h) => {
          h.screen.alt = true;
          h.predictor.typed("a", "key");
          h.screen.alt = false;
        },
      ],
      [
        "P4",
        (h) => {
          h.screen.width = 2;
          h.predictor.typed("a", "key");
          h.screen.width = 80;
        },
      ],
      [
        "P5",
        (h) => {
          h.link.composing = true;
          h.predictor.typed("a", "key");
          h.link.composing = false;
        },
      ],
      [
        "P6",
        (h) => {
          h.link.ready = false;
          h.predictor.typed("a", "key");
          h.link.ready = true;
        },
      ],
      ["P7", (h) => h.predictor.typed("?", "key")],
    ];
    for (const [rule, refuse] of freezing) {
      const h = harness();
      confirmed(h);
      refuse(h);
      expect([rule, h.predictor.typed("z", "key")]).toEqual([rule, { kind: "refused", rule: "P9" }]);
    }
    const h = harness();
    confirmed(h);
    expect(h.predictor.typed("a", "automatic")).toEqual({ kind: "refused", rule: "P10" });
    expect(h.predictor.typed("a", "key")).toMatchObject({ kind: "predicted" });
  });

  test("P10: bytes the terminal answers by itself are not predicted, even one printable character", () => {
    const h = harness();
    confirmed(h);
    expect(h.predictor.typed("0", "automatic")).toEqual({ kind: "refused", rule: "P10" });
    expect(texts(h)).toEqual([]);
  });

  test("P11: scrolled away from the end, predictions are kept and not drawn", () => {
    const h = harness();
    confirmed(h);
    h.predictor.typed("a", "key");
    h.predictor.setScrolledAway(true);
    expect(texts(h)).toEqual([]);
    expect(h.predictor.visibleCursor()).toBeNull();
    h.predictor.setScrolledAway(false);
    expect(texts(h)).toEqual(["a"]);
  });

  test("P12: an observing stream predicts nothing", () => {
    const h = harness({ observe: true });
    confirmed(h);
    expect(h.predictor.typed("a", "key")).toEqual({ kind: "refused", rule: "P12" });
    expect(texts(h)).toEqual([]);
  });
});
