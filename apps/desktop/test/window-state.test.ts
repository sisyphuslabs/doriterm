import { afterEach, describe, expect, jest, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePlacement, restorePlacement, type Area } from "../src/config/window-state.ts";
import { DEFAULT_WINDOW_SIZE, MIN_WINDOW_SIZE } from "../src/config/window.ts";
import { PLACEMENT_SETTLE_MS, rememberPlacement, savedPlacement } from "../src/main/window-state.ts";

const laptop = { x: 0, y: 25, width: 1470, height: 931 };
const external = { x: 1470, y: 0, width: 2560, height: 1415 };

/** A window's placement events, and the bounds it currently has: what the saver reads between events. */
function placedWindow(bounds: Area) {
  const listeners = new Map<string, () => void>();
  let placed = bounds;
  const window = {
    onMove: (listener: () => void) => void listeners.set("move", listener),
    onResize: (listener: () => void) => void listeners.set("resize", listener),
    onClose: (listener: () => void) => void listeners.set("close", listener),
    normalBounds: () => placed,
  };
  return {
    window,
    fire: (event: "move" | "resize" | "close"): void => listeners.get(event)?.(),
    moveTo: (next: Area): void => void (placed = next),
  };
}

/** A placement file of this test's own, removed however the test ends. */
function placementFile(): { readonly file: string; readonly done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "dd-placement-"));
  return { file: join(dir, "placement.json"), done: () => rmSync(dir, { recursive: true, force: true }) };
}

const resting = { x: 40, y: 60, width: 1000, height: 700 };

describe("window placement while the window moves", () => {
  afterEach(() => jest.useRealTimers());

  test("a move saves where the window came to rest, so a crash still reopens it there", () => {
    jest.useFakeTimers();
    const { file, done } = placementFile();
    try {
      const { window, fire, moveTo } = placedWindow({ x: 10, y: 20, width: 900, height: 600 });
      rememberPlacement(window, file);
      moveTo(resting);
      fire("move");
      expect(savedPlacement(file), "nothing is written before the window rests").toBeUndefined();
      jest.advanceTimersByTime(PLACEMENT_SETTLE_MS);
      expect(savedPlacement(file)).toEqual(resting);
    } finally {
      done();
    }
  });

  test("a drag writes once, at rest: nothing while it moves, then the bounds it ended on", () => {
    jest.useFakeTimers();
    const { file, done } = placementFile();
    try {
      const { window, fire, moveTo } = placedWindow({ x: 0, y: 0, width: 900, height: 600 });
      rememberPlacement(window, file);
      for (const x of [20, 60, 120]) {
        moveTo({ x, y: 0, width: 900, height: 600 });
        fire("move");
        jest.advanceTimersByTime(Math.floor(PLACEMENT_SETTLE_MS / 3));
        expect(savedPlacement(file), "a drag still moving is not written").toBeUndefined();
      }
      moveTo({ x: 120, y: 0, width: 1400, height: 900 });
      fire("resize");
      jest.advanceTimersByTime(PLACEMENT_SETTLE_MS);
      expect(savedPlacement(file)).toEqual({ x: 120, y: 0, width: 1400, height: 900 });
    } finally {
      done();
    }
  });

  test("closing writes a placement the settle had not written yet, and leaves it alone after", () => {
    jest.useFakeTimers();
    const { file, done } = placementFile();
    try {
      const { window, fire, moveTo } = placedWindow({ x: 0, y: 0, width: 900, height: 600 });
      rememberPlacement(window, file);
      moveTo(resting);
      fire("move");
      fire("close");
      expect(savedPlacement(file), "closing does not wait for the settle").toEqual(resting);
      moveTo({ x: 5, y: 5, width: 500, height: 400 });
      jest.advanceTimersByTime(PLACEMENT_SETTLE_MS * 2);
      expect(savedPlacement(file), "no save runs after the window closed").toEqual(resting);
    } finally {
      done();
    }
  });
});

describe("window placement across launches", () => {
  test("a saved placement on a display comes back as it was", () => {
    const saved = { x: 1600, y: 100, width: 1200, height: 800 };
    expect(restorePlacement(saved, [laptop, external], laptop)).toEqual(saved);
  });

  test("a window whose bottom or right edge ran past its display moves back onto it", () => {
    expect(restorePlacement({ x: 100, y: 800, width: 1200, height: 800 }, [laptop], laptop)).toEqual({
      x: 100,
      y: laptop.y + laptop.height - 800,
      width: 1200,
      height: 800,
    });
    expect(restorePlacement({ x: 1000, y: 100, width: 1200, height: 800 }, [laptop], laptop)).toEqual({
      x: laptop.width - 1200,
      y: 100,
      width: 1200,
      height: 800,
    });
  });

  test("a placement on an unplugged display opens centred, no larger than the main display", () => {
    expect(restorePlacement({ x: 1600, y: 100, width: 2400, height: 1300 }, [laptop], laptop)).toEqual({
      width: laptop.width,
      height: laptop.height,
    });
    expect(restorePlacement({ x: 5000, y: 100, width: 300, height: 200 }, [laptop], laptop)).toEqual(MIN_WINDOW_SIZE);
  });

  test("a placement larger than its display shrinks to the work area, and none at all is the default", () => {
    expect(restorePlacement({ x: 0, y: 25, width: 2560, height: 1600 }, [laptop], laptop)).toEqual(laptop);
    expect(restorePlacement(undefined, [laptop], laptop)).toEqual(DEFAULT_WINDOW_SIZE);
  });

  test("only four finite numbers read from disk are a placement", () => {
    expect(parsePlacement({ x: 1, y: 2, width: 3, height: 4 })).toEqual({ x: 1, y: 2, width: 3, height: 4 });
    for (const bad of [null, "x", {}, { x: 1, y: 2, width: 3 }, { x: 1, y: 2, width: 3, height: Number.NaN }]) {
      expect(parsePlacement(bad)).toBeUndefined();
    }
  });

  test("a missing placement file is a first launch; an unreadable one is reported", () => {
    const dir = mkdtempSync(join(tmpdir(), "dd-placement-"));
    try {
      const logged: string[] = [];
      const log = (line: string): void => void logged.push(line);
      expect(savedPlacement(join(dir, "missing.json"), log)).toBeUndefined();
      expect(logged).toEqual([]);
      expect(savedPlacement(dir, log)).toBeUndefined();
      expect(logged).toHaveLength(1);
      writeFileSync(join(dir, "placement.json"), JSON.stringify({ x: 1, y: 2, width: 900, height: 600 }));
      expect(savedPlacement(join(dir, "placement.json"), log)).toEqual({ x: 1, y: 2, width: 900, height: 600 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
