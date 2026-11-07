import type { BrowserWindow } from "electron";
import { readFileSync, writeFileSync } from "node:fs";
import { parsePlacement, type Area } from "../config/window-state.ts";

export type Log = (line: string) => void;

/** How long a move or resize rests before its bounds are written: a drag writes once, when it stops. */
export const PLACEMENT_SETTLE_MS = 500;

const isMissing = (error: unknown): boolean =>
  typeof error === "object" && error !== null && Reflect.get(error, "code") === "ENOENT";

/** A JSON file the shell saved earlier: undefined when it does not exist yet; anything else unreadable is reported. */
export function readSaved(file: string, log: Log = console.error): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    if (!isMissing(error)) log(`could not read ${file}: ${String(error)}`);
    return undefined;
  }
}

export function writeSaved(file: string, value: unknown, log: Log = console.error): void {
  try {
    writeFileSync(file, JSON.stringify(value));
  } catch (error) {
    log(`could not save ${file}: ${String(error)}`);
  }
}

/** The last normal (not maximised, not full screen) bounds saved in `file`, or undefined on first launch. */
export function savedPlacement(file: string, log: Log = console.error): Area | undefined {
  return parsePlacement(readSaved(file, log));
}

/** The part of the window placement saving needs: where it is when it rests, and when it moves, resizes and closes. */
export interface PlacedWindow {
  onMove(listener: () => void): void;
  onResize(listener: () => void): void;
  onClose(listener: () => void): void;
  normalBounds(): Area;
}

/** Electron's window as `rememberPlacement` reads it. */
export function placedWindow(window: BrowserWindow): PlacedWindow {
  return {
    onMove: (listener) => void window.on("move", listener),
    onResize: (listener) => void window.on("resize", listener),
    onClose: (listener) => void window.on("close", listener),
    normalBounds: () => window.getNormalBounds(),
  };
}

/** Saves the window's normal bounds when it moves, resizes and closes, so the next launch reopens it there. */
export function rememberPlacement(window: PlacedWindow, file: string, log: Log = console.error): void {
  let settling: ReturnType<typeof setTimeout> | undefined;
  const save = (): void => {
    settling = undefined;
    writeSaved(file, window.normalBounds(), log);
  };
  // A drag or a live resize fires this many times a second: the last one writes once the window rests, so a crash or a
  // kill keeps the place it was left at even though the close that used to be the only writer never came.
  const settle = (): void => {
    clearTimeout(settling);
    settling = setTimeout(save, PLACEMENT_SETTLE_MS);
  };
  window.onMove(settle);
  window.onResize(settle);
  window.onClose(() => {
    clearTimeout(settling);
    save();
  });
}
