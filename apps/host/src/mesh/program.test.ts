import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
  });
});
