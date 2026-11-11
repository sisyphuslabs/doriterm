import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { meshProgram } from "./program.ts";

describe("the program a mesh line's via names (section 7.2, L-D4)", () => {
  test("run from source, the launcher runs the host's CLI, whatever script started this process", () => {
    const dir = mkdtempSync(join(tmpdir(), "dh-program-"));
    try {
      const launcher = meshProgram(dir, join(dir, "some-script.test.ts"));
      const text = readFileSync(launcher, "utf8");
      expect(text).toContain(join(import.meta.dir, "..", "cli.ts"));
      expect(text).not.toContain("some-script.test.ts");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a compiled host names itself", () => {
    expect(meshProgram("/unused", "/opt/doriface-host")).toBe(process.execPath);
    expect(meshProgram("/unused", String.raw`C:\Doriterm\doriface-host.exe`, "win32")).toBe(process.execPath);
  });

  test("on Windows a source run writes no sh launcher, which nothing there could start (#1385)", () => {
    const dir = mkdtempSync(join(tmpdir(), "dh-program-"));
    try {
      expect(meshProgram(dir, join(dir, "some-script.test.ts"), "win32")).toBe(join(import.meta.dir, "..", "cli.ts"));
      expect(readdirSync(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
