import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { buildWindowsSpeechOptional, compilerArguments, compilerCommandFile } from "../scripts/build-speech-win.ts";

const build = {
  root: "/app",
  headers: "/headers/include",
  library: "/app/dist/native/node-v45.2.1-x64.lib",
  outdir: "/app/dist/native",
};

describe("the Windows addon build (#749)", () => {
  test("the addon delay-loads node.exe through the hook, so the executable renamed Doriterm.exe can load it", () => {
    const hook = join("/app", "native", "speech", "win-delay-load-hook.cc");
    expect(existsSync(join(import.meta.dir, "..", "native", "speech", "win-delay-load-hook.cc"))).toBe(true);
    const { compile, link } = compilerArguments(build);
    expect(compile).toContain(hook);
    expect(compile).toContain(join("/app", "native", "speech", "speech-win.cc"));
    expect(link).toContain("/DELAYLOAD:node.exe");
    expect(link).toContain("delayimp.lib");
    expect(link).toContain(build.library);
  });

  test("the command file keeps the linker's options on the /link line and quotes a path with a space", () => {
    const text = compilerCommandFile(compilerArguments({ ...build, headers: "/Program Files/include" }));
    const lines = text.split("\n");
    expect(lines[0]).toContain('"/I/Program Files/include"');
    expect(lines[0]).not.toContain("/link");
    expect(lines[1]).toStartWith("/link ");
    expect(lines[1]).toContain("/DELAYLOAD:node.exe delayimp.lib");
  });
});

describe("the Windows addon is optional until its build is proven on the release runners (#749)", () => {
  test("a build that throws or exits non-zero is reported with its reason and does not fail the build", async () => {
    const lines: string[] = [];
    await buildWindowsSpeechOptional(
      "/app",
      () => Promise.reject(new Error("Electron import library: HTTP 404")),
      (line) => lines.push(line),
    );
    await buildWindowsSpeechOptional(
      "/app",
      () => Promise.resolve(false),
      (line) => lines.push(line),
    );
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("Electron import library: HTTP 404");
    expect(lines[0]).toContain("can't dictate");
    expect(lines[1]).toContain("can't dictate");
  });

  test("a build that produces the addon says nothing", async () => {
    const lines: string[] = [];
    const roots: string[] = [];
    await buildWindowsSpeechOptional(
      "/app",
      (root) => {
        roots.push(root);
        return Promise.resolve(true);
      },
      (line) => lines.push(line),
    );
    expect(roots).toEqual(["/app"]);
    expect(lines).toEqual([]);
  });
});
