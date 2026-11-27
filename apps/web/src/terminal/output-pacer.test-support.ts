import type { FrameTimer } from "./output-pacer.ts";

/** Animation frames that run only when the test says so. */
export function manualFrames() {
  const frames: (() => void)[] = [];
  const frame: FrameTimer = (run) => {
    frames.push(run);
    return () => frames.splice(frames.indexOf(run), 1);
  };
  return { frame, frames, nextFrame: (): void => frames.shift()?.() };
}

/** Timers on a clock that moves only when the test advances it; due timers run in order of when they are due. */
export function manualTimers() {
  let now = 0;
  const due: { at: number; run: () => void }[] = [];
  const timer = (run: () => void, ms: number): (() => void) => {
    const entry = { at: now + ms, run };
    due.push(entry);
    return () => {
      const at = due.indexOf(entry);
      if (at !== -1) due.splice(at, 1);
    };
  };
  const advance = (ms: number): void => {
    const until = now + ms;
    for (;;) {
      const next = due.filter((entry) => entry.at <= until).toSorted((a, b) => a.at - b.at)[0];
      if (next === undefined) break;
      due.splice(due.indexOf(next), 1);
      now = next.at;
      next.run();
    }
    now = until;
  };
  return { timer, advance, now: () => now };
}

export const KIB = 1024;

export const bytes = (length: number, fill = 0x61) => new Uint8Array(length).fill(fill);

export const text = (value: string) => new TextEncoder().encode(value);
export const OPEN = "\u001b[?2026h";
export const CLOSE = "\u001b[?2026l";
