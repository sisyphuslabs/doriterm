import { describe, expect, test } from "bun:test";
import { inStep } from "./spinner.tsx";

/** An animation that counts how often its start time is written. */
function fakeAnimation(startTime: number, playState: AnimationPlayState = "running") {
  const animation = {
    playState,
    writes: 0,
    current: startTime,
    get startTime(): number {
      return animation.current;
    },
    set startTime(value: number) {
      animation.writes += 1;
      animation.current = value;
    },
  };
  return animation;
}

const glyph = (animations: readonly ReturnType<typeof fakeAnimation>[]) =>
  ({ getAnimations: () => animations }) as unknown as SVGSVGElement;

describe("putting a spinner in step", () => {
  test("moves an animation that started late onto the shared clock", () => {
    const late = fakeAnimation(4_250);
    inStep(glyph([late]));
    expect(late.startTime).toBe(0);
  });

  // The spinner re-runs this on every render; an animation already on the shared clock is left alone (#1555).
  test("writes nothing on a re-render with nothing changed", () => {
    const late = fakeAnimation(4_250);
    const element = glyph([late]);
    inStep(element);
    inStep(element);
    inStep(element);
    expect(late.writes).toBe(1);
  });

  // Writing a paused turn's start time would set it going again (the landing's motion toggle pauses spinners, #1179).
  test("leaves a paused turn as it stands", () => {
    const paused = fakeAnimation(4_250, "paused");
    inStep(glyph([paused]));
    expect(paused.writes).toBe(0);
  });
});
