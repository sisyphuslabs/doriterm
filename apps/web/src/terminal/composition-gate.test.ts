import { describe, expect, test } from "bun:test";
import { CompositionGate } from "./composition-gate.ts";

describe("CompositionGate, the predictor's composing() source (HIGH 3(a))", () => {
  test("composing from compositionstart until compositionend", () => {
    const target = new EventTarget();
    const gate = new CompositionGate(target);
    expect(gate.composing()).toBe(false);
    target.dispatchEvent(new Event("compositionstart"));
    expect(gate.composing()).toBe(true);
    target.dispatchEvent(new Event("compositionend"));
    expect(gate.composing()).toBe(false);
  });

  test("dispose removes both listeners", () => {
    const target = new EventTarget();
    const gate = new CompositionGate(target);
    gate.dispose();
    target.dispatchEvent(new Event("compositionstart"));
    expect(gate.composing()).toBe(false);
    const started = new CompositionGate(target);
    target.dispatchEvent(new Event("compositionstart"));
    started.dispose();
    target.dispatchEvent(new Event("compositionend"));
    expect(started.composing()).toBe(true);
  });

  // wterm commits the syllable from its own compositionend listener on the textarea. The gate listens in the capture
  // phase on an ancestor, so it has flipped before any target-phase listener runs, even one registered before it.
  test("a listener registered earlier without capture already sees the composition ended", () => {
    const target = new EventTarget();
    const seen: boolean[] = [];
    let gate: CompositionGate | undefined;
    target.addEventListener("compositionend", () => seen.push(gate?.composing() ?? true));
    gate = new CompositionGate(target);
    target.dispatchEvent(new Event("compositionstart"));
    target.dispatchEvent(new Event("compositionend"));
    expect(seen).toEqual([false]);
  });

  test("fromInputEvent: only a composing InputEvent counts", () => {
    expect(CompositionGate.fromInputEvent(new Event("input"))).toBe(false);
  });
});
