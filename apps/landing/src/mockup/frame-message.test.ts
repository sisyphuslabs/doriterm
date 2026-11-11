import { expect, test } from "bun:test";
import { applyFrameMessage, holdMotion } from "./frame-message.ts";

const root = (): Pick<HTMLElement, "dataset"> => ({ dataset: {} as DOMStringMap });

test("the landing's pinned theme maps to the app's preset, and system lets the mockup follow the page", () => {
  const html = root();
  applyFrameMessage(html, { theme: "dark" });
  expect(html.dataset["theme"]).toBe("night");
  applyFrameMessage(html, { theme: null });
  expect(html.dataset["theme"]).toBeUndefined();
});

test("the landing's motion toggle pauses the mockup's animations and resumes them (#1179)", () => {
  const html = root();
  applyFrameMessage(html, { motionPaused: true });
  expect(html.dataset["motion"]).toBe("paused");
  // A theme message alone leaves the pause as it was.
  applyFrameMessage(html, { theme: "light" });
  expect(html.dataset["motion"]).toBe("paused");
  applyFrameMessage(html, { motionPaused: false });
  expect(html.dataset["motion"]).toBeUndefined();
});

/** A stand-in animation that records the pause() and play() calls made on it. */
const made = (iterations: number, playState: AnimationPlayState) => {
  const calls: string[] = [];
  const animation = {
    playState,
    startTime: 5 as number | null,
    effect: { getComputedTiming: () => ({ iterations }) },
    pause: () => calls.push("pause"),
    play: () => calls.push("play"),
  };
  return { animation, calls };
};

test("holding motion pauses every animation, and resuming restarts loops on the shared clock (#1179)", () => {
  const loop = made(Number.POSITIVE_INFINITY, "running");
  const once = made(1, "running");
  const view = { getAnimations: () => [loop.animation, once.animation] as unknown as Animation[] };
  holdMotion(view, true);
  expect([loop.calls, once.calls]).toEqual([["pause"], ["pause"]]);

  const done = made(1, "finished");
  const held = made(1, "paused");
  holdMotion(
    { getAnimations: () => [loop.animation, done.animation, held.animation] as unknown as Animation[] },
    false,
  );
  expect(loop.animation.startTime).toBe(0);
  expect([done.calls, held.calls]).toEqual([[], ["play"]]);
});
