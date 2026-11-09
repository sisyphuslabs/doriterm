import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lastWindowClosed, saveRunInBackground, savedRunInBackground } from "../src/main/background.ts";

const dirs: string[] = [];
const scratchFile = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "dd-background-"));
  dirs.push(dir);
  return join(dir, "run-in-background.json");
};

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("closing the last window (#1500)", () => {
  test("off, it does what it always has: a Mac stays in the Dock, Windows and Linux quit", () => {
    expect(lastWindowClosed("darwin", false)).toBe("stay");
    expect(lastWindowClosed("win32", false)).toBe("quit");
    expect(lastWindowClosed("linux", false)).toBe("quit");
  });

  test("on, the app never quits: a Mac drops its Dock icon, Windows and Linux keep running with no window", () => {
    expect(lastWindowClosed("darwin", true)).toBe("hide");
    expect(lastWindowClosed("win32", true)).toBe("stay");
    expect(lastWindowClosed("linux", true)).toBe("stay");
  });
});

describe("Keep running in the background is kept across launches", () => {
  test("is off until it is turned on, and reads back what was saved", () => {
    const file = scratchFile();
    expect(savedRunInBackground(file)).toBe(false);
    saveRunInBackground(file, true);
    expect(savedRunInBackground(file)).toBe(true);
    saveRunInBackground(file, false);
    expect(savedRunInBackground(file)).toBe(false);
  });

  test("anything but a saved true reads as off, so a damaged file keeps today's behaviour", () => {
    const file = scratchFile();
    const logged: string[] = [];
    for (const content of ["{not json", '{"enabled":"yes"}', '{"enabled":1}', "true", "null"]) {
      writeFileSync(file, content);
      expect(
        savedRunInBackground(file, (line) => logged.push(line)),
        content,
      ).toBe(false);
    }
    expect(logged).toHaveLength(1);
  });
});
