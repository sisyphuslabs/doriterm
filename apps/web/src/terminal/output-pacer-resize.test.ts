import { expect, test } from "bun:test";
import { OutputPacer } from "./output-pacer.ts";
import { bytes, KIB, manualFrames, manualTimers, OPEN, text } from "./output-pacer.test-support.ts";

// A shell redraws its prompt each time the view resizes (bash 3.2 and zsh do on SIGWINCH). Inside an update a program
// left open, those bytes answer the resize; they are not the update still being drawn, so they do not keep its paint
// held: a resize drag must not freeze the screen until the hold's cap (#2922, #853).

/** The view's width in columns: three rows of it, 240 bytes, may answer a resize. */
const COLS = 80;
/** A screen of a program's redraw: more than a shell's answer to a resize. */
const SCREEN = 4 * KIB;

/** A pacer with a program's update held, over a 100 ms round trip: 1.5 x SRTT + 50 = 200 ms for a resize's answer. */
function holding() {
  const frames = manualFrames();
  const timers = manualTimers();
  const holds: string[] = [];
  const pacer = new OutputPacer(() => undefined, frames.frame, timers.now, timers.timer);
  pacer.holdSynchronized((held) => holds.push(held ? "held" : "let go"));
  pacer.replay({ srtt: () => 100, hold: () => undefined });
  pacer.push(bytes(KIB));
  pacer.push(new Uint8Array([...text(OPEN), ...text("open-853\r\n")]));
  return { frames, timers, holds, pacer };
}

/** A pacer over a 100 ms round trip with no update open yet. */
function drag() {
  const frames = manualFrames();
  const timers = manualTimers();
  const holds: string[] = [];
  const pacer = new OutputPacer(() => undefined, frames.frame, timers.now, timers.timer);
  pacer.holdSynchronized((held) => holds.push(held ? "held" : "let go"));
  pacer.replay({ srtt: () => 100, hold: () => undefined });
  pacer.push(bytes(KIB));
  frames.nextFrame();
  timers.advance(2000);
  return { frames, timers, holds, pacer };
}

/** The shell's answer to a resize: it clears its line and draws the prompt again. */
const prompt = (): Uint8Array => text(`\r${" ".repeat(60)}\rbash-3.2$ `);

test("a prompt redrawn after every resize of a drag does not keep an open update held: it paints a second after it opened", () => {
  const { frames, timers, holds, pacer } = holding();
  expect(holds).toEqual(["held"]);
  // A drag: a resize every 200 ms, the shell's prompt 20 ms after each, the page writing every frame.
  for (let step = 0; step < 4; step += 1) {
    timers.advance(180);
    pacer.resized(COLS);
    timers.advance(20);
    pacer.push(prompt());
    frames.nextFrame();
  }
  // 800 ms after it opened the update is still held; at 1000 ms, its quiet window from the open ends.
  expect(holds).toEqual(["held"]);
  timers.advance(200);
  expect(holds).toEqual(["held", "let go"]);
});

test("bytes a program sends later than a round trip after a resize are still the update being drawn", () => {
  const { frames, timers, holds, pacer } = holding();
  timers.advance(500);
  pacer.resized(COLS);
  timers.advance(250);
  pacer.push(bytes(KIB));
  frames.nextFrame();
  // 250 ms after the resize, past its 200 ms answer: the window starts again at 750 ms, so the update is still held at
  // 1000 ms after it opened, and let go a second after those bytes.
  timers.advance(999);
  expect(holds).toEqual(["held"]);
  timers.advance(1);
  expect(holds).toEqual(["held", "let go"]);
});

test("with no resize, bytes inside an open update keep its paint held, as before (#2040)", () => {
  const { frames, timers, holds, pacer } = holding();
  for (let step = 0; step < 4; step += 1) {
    timers.advance(200);
    pacer.push(prompt());
    frames.nextFrame();
  }
  timers.advance(200);
  expect(holds).toEqual(["held"]);
  timers.advance(800);
  expect(holds).toEqual(["held", "let go"]);
});

test("an update a program opens in answer to the resize is held across an in-window chunk and a gap under the window (#2040)", () => {
  const { frames, timers, holds, pacer } = drag();
  pacer.resized(COLS);
  timers.advance(10);
  pacer.push(new Uint8Array([...text(OPEN), ...bytes(SCREEN)]));
  frames.nextFrame();
  timers.advance(180);
  pacer.push(bytes(SCREEN));
  frames.nextFrame();
  // 900 ms after its last bytes, under the 1 s window: still being drawn.
  timers.advance(900);
  expect(holds).toEqual(["held"]);
  timers.advance(100);
  expect(holds).toEqual(["held", "let go"]);
});

test("a slow redraw opened during a drag stays held while it keeps coming, and is let go once it goes quiet (#757)", () => {
  const { frames, timers, holds, pacer } = drag();
  pacer.resized(COLS);
  timers.advance(10);
  pacer.push(new Uint8Array([...text(OPEN), ...bytes(SCREEN)]));
  frames.nextFrame();
  // A resize every 100 ms for 3 s, a screen of the redraw every 300 ms, the update not yet closed.
  for (let at = 100; at <= 3000; at += 100) {
    timers.advance(100);
    pacer.resized(COLS);
    if (at % 300 === 0) {
      pacer.push(bytes(SCREEN));
      frames.nextFrame();
    }
  }
  expect(holds).toEqual(["held"]);
  timers.advance(1000);
  expect(holds).toEqual(["held", "let go"]);
});

test("an update opened just after a drag began, with only prompt redraws after it, still paints a second after it opened", () => {
  const { frames, timers, holds, pacer } = drag();
  // The drag's first resize lands before the program's update does.
  pacer.resized(COLS);
  timers.advance(20);
  pacer.push(new Uint8Array([...text(OPEN), ...text("open-853\r\n")]));
  frames.nextFrame();
  for (let step = 0; step < 4; step += 1) {
    timers.advance(180);
    pacer.resized(COLS);
    timers.advance(20);
    pacer.push(prompt());
    frames.nextFrame();
  }
  expect(holds).toEqual(["held"]);
  timers.advance(200);
  expect(holds).toEqual(["held", "let go"]);
});

test("on a narrow terminal a themed prompt redrawn after every resize still does not keep an open update held", () => {
  const { frames, timers, holds, pacer } = holding();
  // 40 columns (a phone, a narrow split): three rows are 120 bytes, a themed prompt is about 200.
  const themed = text(`\r${" ".repeat(39)}\r${"\u001b[38;5;39m".repeat(12)}~/work main ❯ `);
  expect(themed.byteLength).toBeGreaterThan(3 * 40);
  for (let step = 0; step < 4; step += 1) {
    timers.advance(180);
    pacer.resized(40);
    timers.advance(20);
    pacer.push(themed);
    frames.nextFrame();
  }
  expect(holds).toEqual(["held"]);
  timers.advance(200);
  expect(holds).toEqual(["held", "let go"]);
});
