import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { renderService, type SetupOs, setupPaths } from "./render.ts";
import { DEFAULT_FLAG, resolvePaths, type SetupContext } from "./setup.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const context = (os: SetupOs, home: string, options: SetupContext["options"]): SetupContext => ({
  os,
  home,
  env: {},
  report: () => {},
  options,
  run: () => Promise.resolve({ code: 0, stdout: "", stderr: "" }),
});

test("--listen default and --session default clear what the installed service ran with (#821)", () => {
  for (const os of ["linux", "mac"] as const) {
    const home = mkdtempSync(join(tmpdir(), "dt-setup-defaults-"));
    roots.push(home);
    const tools = { bun: process.execPath, hc: join(home, "hc"), shell: "/bin/sh" };
    const installed = setupPaths(os, home, {}, tools, {
      stateDir: join(home, "state"),
      listen: "127.0.0.1:0",
      session: "work",
    });
    mkdirSync(dirname(installed.serviceFile), { recursive: true });
    writeFileSync(installed.serviceFile, renderService(installed));
    const options = { src: installed.src, listen: DEFAULT_FLAG, session: DEFAULT_FLAG };
    const after = resolvePaths(context(os, home, options), tools.hc);
    expect([after.listen, after.session, after.stateDir]).toEqual([undefined, undefined, installed.stateDir]);
    expect(renderService(after)).toBe(renderService({ ...installed, listen: undefined, session: undefined }));
  }
});

test("on a machine with no service yet, default is the host's default, never a literal value (#821)", () => {
  const home = mkdtempSync(join(tmpdir(), "dt-setup-defaults-"));
  roots.push(home);
  const after = resolvePaths(context("linux", home, { listen: DEFAULT_FLAG, session: DEFAULT_FLAG }), join(home, "hc"));
  expect([after.listen, after.session]).toEqual([undefined, undefined]);
});
