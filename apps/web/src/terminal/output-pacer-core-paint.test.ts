import { expect, test } from "bun:test";
import { OutputPacer, REPLAY_MAX_BYTES, SYNCHRONIZED_HOLD_CAP_MS } from "./output-pacer.ts";
import { bytes, CLOSE, KIB, manualFrames, manualTimers, OPEN, text } from "./output-pacer.test-support.ts";

// A core that sends its paint as one synchronized update (herdr-core #232) marks where the replay ends: the paint is held
// until that update closes, however slow the link or the page, and no timing rule guesses at its end (#2794).

/** A pacer in an attach replay over a 1.2 s round trip, recording each hold: the replay's and the update's. */
function attached() {
  const frames = manualFrames();
  const timers = manualTimers();
  const holds: string[] = [];
  const written: number[] = [];
  const pacer = new OutputPacer((batch) => written.push(batch.byteLength), frames.frame, timers.now, timers.timer);
  pacer.holdSynchronized((held) => holds.push(`update ${held ? "held" : "let go"}`));
  pacer.replay({ srtt: () => 1200, hold: (held) => holds.push(`replay ${held ? "held" : "let go"}`) });
  return { frames, timers, holds, written, pacer };
}

test("a replay that opens with the core's synchronized update is held until it closes, past every quiet window and the cap", () => {
  const { timers, holds, written, pacer } = attached();
  pacer.push(new Uint8Array([...text(OPEN), ...bytes(256 * KIB)]));
  expect(holds).toEqual(["replay held", "update held", "replay let go"]);
  // A starved link: a window every 6 s for 48 s, far past the quiet window (1.5 x SRTT + 50) and the 20 s cap.
  for (let window = 0; window < 8; window += 1) {
    timers.advance(6000);
    pacer.push(bytes(128 * KIB));
  }
  expect(timers.now()).toBeGreaterThan(SYNCHRONIZED_HOLD_CAP_MS);
  expect(holds).toEqual(["replay held", "update held", "replay let go"]);
  pacer.push(text(CLOSE));
  expect(holds).toEqual(["replay held", "update held", "replay let go", "update let go"]);
  // Every byte was written as it came, while the paint was held.
  expect(written.reduce((sum, size) => sum + size, 0)).toBe(OPEN.length + 256 * KIB + 8 * 128 * KIB + CLOSE.length);
});

test("the core's paint is let go once it has written as much as a replay may hold, closed or not", () => {
  const { holds, pacer } = attached();
  pacer.push(new Uint8Array([...text(OPEN), ...bytes(1024 * KIB)]));
  expect(holds.at(-1)).toBe("replay let go");
  pacer.push(bytes(REPLAY_MAX_BYTES - 1024 * KIB - OPEN.length - 1));
  expect(holds.at(-1)).toBe("replay let go");
  pacer.push(bytes(1));
  expect(holds.at(-1)).toBe("update let go");
});

test("a core paint left open when its stream closes is drawn as it stands, and output queued after it is still written", () => {
  const { frames, timers, holds, written, pacer } = attached();
  pacer.push(new Uint8Array([...text(OPEN), ...bytes(64 * KIB)]));
  timers.advance(60_000);
  expect(holds.at(-1)).toBe("replay let go");
  pacer.streamClosed();
  expect(holds.at(-1)).toBe("update let go");
  // Nothing it wrote is lost, and what comes after it is paced as usual.
  pacer.push(bytes(KIB));
  frames.nextFrame();
  expect(written).toEqual([OPEN.length + 64 * KIB, KIB]);
});

test("a core paint left open is let go when the view drops the stream, as on a reattach", () => {
  const { timers, holds, pacer } = attached();
  pacer.push(new Uint8Array([...text(OPEN), ...bytes(64 * KIB)]));
  timers.advance(60_000);
  expect(holds.at(-1)).toBe("replay let go");
  pacer.drop();
  expect(holds.at(-1)).toBe("update let go");
});

test("a stream closing with no core paint held changes nothing: a program's update keeps its own rules", () => {
  const { timers, holds, pacer } = attached();
  pacer.push(bytes(KIB));
  pacer.push(new Uint8Array([...text(OPEN), ...bytes(KIB)]));
  pacer.streamClosed();
  expect(holds).toEqual(["replay held", "update held", "replay let go"]);
  timers.advance(1850);
  expect(holds.at(-1)).toBe("update let go");
});

test("an update a program opens later in the replay keeps the rules for a program's update: let go once it goes quiet", () => {
  const { timers, holds, pacer } = attached();
  pacer.push(bytes(KIB));
  pacer.push(new Uint8Array([...text(OPEN), ...bytes(KIB)]));
  expect(holds).toEqual(["replay held", "update held", "replay let go"]);
  // max(1000, 1.5 x 1200 + 50) = 1850 ms with no bytes: an update a program left open.
  timers.advance(1849);
  expect(holds.at(-1)).toBe("replay let go");
  timers.advance(1);
  expect(holds.at(-1)).toBe("update let go");
});

test("after the core's paint closes, the next update the program opens is a program's again", () => {
  const { frames, timers, holds, pacer } = attached();
  pacer.push(new Uint8Array([...text(OPEN), ...bytes(KIB), ...text(CLOSE)]));
  // Opened and closed in one push, it held nothing on its own (#812): the replay stood down for it.
  expect(holds).toEqual(["replay held", "replay let go"]);
  pacer.push(new Uint8Array([...text(OPEN), ...bytes(KIB)]));
  // Paced again once the replay is let go: written, and held, at the next frame.
  frames.nextFrame();
  expect(holds.at(-1)).toBe("update held");
  timers.advance(1850);
  expect(holds.at(-1)).toBe("update let go");
});
