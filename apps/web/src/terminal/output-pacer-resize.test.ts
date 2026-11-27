import { expect, test } from "bun:test";
import { OutputPacer } from "./output-pacer.ts";
import { bytes, KIB, manualFrames, manualTimers, OPEN, text } from "./output-pacer.test-support.ts";

// A shell redraws its prompt each time the view resizes (bash 3.2 and zsh do on SIGWINCH). Inside an update a program
// left open, those bytes answer the resize; they are not the update still being drawn, so they do not keep its paint
// held: a resize drag must not freeze the screen until the hold's cap (#2922, #853).

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

/** The shell's answer to a resize: it clears its line and draws the prompt again. */
const prompt = (): Uint8Array => text(`\r${" ".repeat(60)}\rbash-3.2$ `);

test("a prompt redrawn after every resize of a drag does not keep an open update held: it paints a second after it opened", () => {
  const { frames, timers, holds, pacer } = holding();
  expect(holds).toEqual(["held"]);
  // A drag: a resize every 200 ms, the shell's prompt 20 ms after each, the page writing every frame.
  for (let step = 0; step < 4; step += 1) {
    timers.advance(180);
    pacer.resized();
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
  pacer.resized();
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
