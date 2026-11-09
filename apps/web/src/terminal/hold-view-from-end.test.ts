import { expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { END_TOLERANCE_PX, fromEndOf, holdFromEnd, type ReplayWriter } from "./hold-view-from-end.ts";
import type { FrameTimer } from "./output-pacer.ts";

/** Animation frames that run only when the test says so. */
function manualFrames() {
  const frames: (() => void)[] = [];
  const frame: FrameTimer = (run) => {
    frames.push(run);
    return () => frames.splice(frames.indexOf(run), 1);
  };
  return { frame, frames, nextFrame: (): void => frames.shift()?.() };
}

/** A replay's writer the test drives: each `write()` is a batch written to the terminal, `busy` what is still queued. */
function manualReplay() {
  const listeners = new Set<() => void>();
  const replay: { busy: boolean; onWrite: ReplayWriter["onWrite"] } = {
    busy: true,
    onWrite: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  return {
    replay,
    write: (): void => {
      for (const listener of listeners) listener();
    },
    get listening(): number {
      return listeners.size;
    },
  };
}

const scroller = (scrollTop: number, scrollHeight: number, clientHeight = 100) => ({
  scrollTop,
  scrollHeight,
  clientHeight,
});

test("a reader at the end is held there once a batch has painted", () => {
  const element = scroller(400, 500);
  const replay = manualReplay();
  const frames = manualFrames();
  holdFromEnd(element, replay.replay, fromEndOf(element), frames.frame);
  element.scrollHeight = 900;
  replay.write();
  frames.nextFrame();
  expect(element.scrollTop).toBe(800);
});

test("the reset's own paint is placed: a reader at the end stays at the bottom of the rows it left standing", () => {
  const element = scroller(400, 500);
  const replay = manualReplay();
  replay.replay.busy = false;
  const frames = manualFrames();
  holdFromEnd(element, replay.replay, fromEndOf(element), frames.frame);
  // The reset renders with the old rows still in the DOM and the scroller moved to the top (#1040's frame).
  element.scrollTop = 0;
  element.scrollHeight = 480;
  expect(frames.frames.length).toBe(1);
  frames.nextFrame();
  expect(element.scrollTop).toBe(380);
  // Nothing written yet: an idle writer does not end the hold before the replay has even started.
  expect(replay.listening).toBe(1);
});

test("a reader at the end is held again after the reset collapses the scroller", () => {
  const element = scroller(400, 500);
  const fromEnd = fromEndOf(element);
  const replay = manualReplay();
  const frames = manualFrames();
  holdFromEnd(element, replay.replay, fromEnd, frames.frame);
  // The reset's own render runs before any batch, emptying the scroller: the height and the position drop.
  element.scrollHeight = 100;
  element.scrollTop = 0;
  frames.nextFrame();
  expect(element.scrollTop).toBe(0);
  // The replay's rows then grow it again.
  element.scrollHeight = 900;
  replay.write();
  frames.nextFrame();
  expect(element.scrollTop).toBe(800);
});

test("a reader up in history is put back at their distance from the end as each batch paints", () => {
  const element = scroller(100, 500);
  // Read before the reset, as a reattach does: this is the place that gets destroyed by it.
  const fromEnd = fromEndOf(element);
  element.scrollHeight = 100;
  element.scrollTop = 0;
  const replay = manualReplay();
  const frames = manualFrames();
  holdFromEnd(element, replay.replay, fromEnd, frames.frame);
  frames.nextFrame();
  // Too little replayed yet to be that far above the end: the top is as far as it goes.
  element.scrollHeight = 300;
  replay.write();
  frames.nextFrame();
  expect(element.scrollTop).toBe(0);
  element.scrollHeight = 900;
  replay.write();
  frames.nextFrame();
  expect(element.scrollTop).toBe(500);
});

test("the hold outlasts the writer going idle until the last batch written has painted (#1394 review)", () => {
  const element = scroller(100, 500);
  const fromEnd = fromEndOf(element);
  element.scrollHeight = 100;
  element.scrollTop = 0;
  const replay = manualReplay();
  const frames = manualFrames();
  holdFromEnd(element, replay.replay, fromEnd, frames.frame);
  frames.nextFrame();
  // The last batch is written: the writer is idle from here, but the batch paints only on the next frame.
  replay.replay.busy = false;
  replay.write();
  expect(element.scrollTop).toBe(0);
  element.scrollHeight = 900;
  frames.nextFrame();
  expect(element.scrollTop).toBe(500);
  expect(replay.listening).toBe(0);
  expect(frames.frames.length).toBe(0);
});

test("wterm's own follow landing at the target is not a reader scrolling away", () => {
  const element = scroller(400, 500);
  const replay = manualReplay();
  const frames = manualFrames();
  holdFromEnd(element, replay.replay, fromEndOf(element), frames.frame);
  frames.nextFrame();
  // The batch's render grows the content and follows it to the new end before the hold's frame runs.
  element.scrollHeight = 900;
  element.scrollTop = 800;
  replay.replay.busy = false;
  replay.write();
  frames.nextFrame();
  expect(element.scrollTop).toBe(800);
  expect(replay.listening).toBe(0);
});

test("a batch written before the booked frame runs rebooks it, so one frame places after the latest paint", () => {
  const element = scroller(400, 500);
  const replay = manualReplay();
  const frames = manualFrames();
  holdFromEnd(element, replay.replay, fromEndOf(element), frames.frame);
  replay.write();
  replay.write();
  expect(frames.frames.length).toBe(1);
});

test("the emptied scroller alone reads as at the end, which is why the caller measures first", () => {
  expect(fromEndOf(scroller(0, 100))).toBe(0);
});

test("a reader within the tolerance of the end is at it; one at the tolerance is away", () => {
  expect(fromEndOf(scroller(400 - END_TOLERANCE_PX + 1, 500))).toBe(0);
  expect(fromEndOf(scroller(400 - END_TOLERANCE_PX, 500))).toBe(END_TOLERANCE_PX);
});

test("the tolerance is the installed @wterm/dom's own line for a view at its bottom", async () => {
  const bundle = join(dirname(Bun.resolveSync("@wterm/dom", import.meta.dir)), "wterm.js");
  const line = /el\.scrollHeight - el\.scrollTop - el\.clientHeight < (\d+);/.exec(await Bun.file(bundle).text())?.[1];
  expect(line).toBeDefined();
  expect(Number(line)).toBe(END_TOLERANCE_PX);
});

test("the hold lets go when the reader scrolls away from where it put them", () => {
  const element = scroller(400, 500);
  const replay = manualReplay();
  const frames = manualFrames();
  holdFromEnd(element, replay.replay, fromEndOf(element), frames.frame);
  replay.write();
  frames.nextFrame();
  element.scrollTop = 250;
  element.scrollHeight = 1200;
  replay.write();
  frames.nextFrame();
  expect(element.scrollTop).toBe(250);
  expect(replay.listening).toBe(0);
});

test("a reader held in history who scrolls elsewhere is let go", () => {
  const element = scroller(100, 500);
  const replay = manualReplay();
  const frames = manualFrames();
  holdFromEnd(element, replay.replay, fromEndOf(element), frames.frame);
  replay.write();
  frames.nextFrame();
  element.scrollTop = 350;
  element.scrollHeight = 1200;
  replay.write();
  frames.nextFrame();
  expect(element.scrollTop).toBe(350);
  expect(replay.listening).toBe(0);
});

test("stop cancels the booked frame and stops listening", () => {
  const element = scroller(400, 500);
  const replay = manualReplay();
  const frames = manualFrames();
  const hold = holdFromEnd(element, replay.replay, fromEndOf(element), frames.frame);
  replay.write();
  hold.stop();
  expect(frames.frames.length).toBe(0);
  expect(replay.listening).toBe(0);
});
